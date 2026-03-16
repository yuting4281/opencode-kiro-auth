import type { AmazonQRequest, AmazonQHistoryMessage, AmazonQTool, AmazonQToolResult, AmazonQToolUse } from "./types.js"
import { mapModelName } from "./models.js"

const THINKING_HINT = "<thinking_mode>interleaved</thinking_mode><max_thinking_length>16000</max_thinking_length>"
const THINKING_START_TAG = "<thinking>"
const THINKING_END_TAG = "</thinking>"

interface ClaudeMessage {
  role: string
  content: string | ContentBlock[]
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ContentBlock[]
  is_error?: boolean
  status?: string
  source?: { type?: string; media_type?: string; data?: string }
}

interface ClaudeTool {
  name: string
  description?: string
  input_schema: unknown
}

export interface ClaudeRequestBody {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  stream?: boolean
  system?: string | ContentBlock[]
  tools?: ClaudeTool[]
  thinking?: unknown
}

function isThinkingEnabled(thinking: unknown): boolean {
  if (!thinking) return false
  if (typeof thinking === "boolean") return thinking
  if (typeof thinking === "string") return thinking.toLowerCase() === "enabled"
  if (typeof thinking === "object" && thinking !== null) {
    const t = thinking as Record<string, unknown>
    if (String(t.type ?? "").toLowerCase() === "enabled") return true
    if (typeof t.enabled === "boolean") return t.enabled
    if (typeof t.budget_tokens === "number" && t.budget_tokens > 0) return true
  }
  return false
}

function appendThinkingHint(text: string): string {
  const normalized = (text || "").trimEnd()
  if (normalized.endsWith(THINKING_HINT)) return text
  if (!text) return THINKING_HINT
  const sep = text.endsWith("\n") || text.endsWith("\r") ? "" : "\n"
  return `${text}${sep}${THINKING_HINT}`
}

function wrapThinking(text: string): string {
  return `${THINKING_START_TAG}${text}${THINKING_END_TAG}`
}

function getTimestamp(): string {
  const now = new Date()
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" })
  return `${weekday}, ${now.toISOString()}`
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((b) => {
      if (b.type === "text") return b.text ?? ""
      if (b.type === "thinking") return wrapThinking(b.thinking ?? "")
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function extractImages(content: string | ContentBlock[]): Array<{ format: string; source: { bytes: string } }> | undefined {
  if (typeof content === "string") return undefined
  const images: Array<{ format: string; source: { bytes: string } }> = []
  for (const b of content) {
    if (b.type === "image" && b.source?.type === "base64") {
      const mt = b.source.media_type ?? "image/png"
      images.push({ format: mt.split("/").pop() ?? "png", source: { bytes: b.source.data ?? "" } })
    }
  }
  return images.length ? images : undefined
}

function processToolResult(block: ContentBlock): AmazonQToolResult {
  const rawContent = block.content
  const aqContent: Array<{ text: string }> = []

  if (typeof rawContent === "string") {
    aqContent.push({ text: rawContent })
  } else if (Array.isArray(rawContent)) {
    for (const item of rawContent) {
      if (typeof item === "string") aqContent.push({ text: item })
      else if (typeof item === "object" && item !== null) {
        const t = (item as ContentBlock).text
        if (t) aqContent.push({ text: t })
      }
    }
  }

  if (!aqContent.some((i) => i.text.trim())) {
    const isError = block.status === "error" || block.is_error
    aqContent.length = 0
    aqContent.push({ text: isError ? "Tool use was cancelled by the user" : "Command executed successfully" })
  }

  return {
    toolUseId: block.tool_use_id ?? "",
    content: aqContent,
    status: block.status === "error" || block.is_error ? "error" : "success",
  }
}

function convertTool(tool: ClaudeTool): AmazonQTool {
  let desc = tool.description ?? ""
  if (desc.length > 10240) desc = desc.slice(0, 10100) + "\n\n...(Full description provided in TOOL DOCUMENTATION section)"
  return { toolSpecification: { name: tool.name, description: desc, inputSchema: { json: tool.input_schema } } }
}

function reorderToolResults(results: AmazonQToolResult[], order: string[]): AmazonQToolResult[] {
  if (!order.length || !results.length) return results
  const byId = new Map(results.map((r) => [r.toolUseId, r]))
  const ordered: AmazonQToolResult[] = []
  for (const id of order) {
    const r = byId.get(id)
    if (r) { ordered.push(r); byId.delete(id) }
  }
  ordered.push(...byId.values())
  return ordered
}

function processHistory(messages: ClaudeMessage[], thinkingEnabled: boolean): AmazonQHistoryMessage[] {
  const raw: AmazonQHistoryMessage[] = []
  let lastToolUseOrder: string[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content
      let textContent = ""
      let toolResults: AmazonQToolResult[] | undefined
      const images = extractImages(content)

      if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === "text") textParts.push(block.text ?? "")
          else if (block.type === "thinking") textParts.push(wrapThinking(block.thinking ?? ""))
          else if (block.type === "tool_result") {
            if (!toolResults) toolResults = []
            const result = processToolResult(block)
            const existing = toolResults.find((r) => r.toolUseId === result.toolUseId)
            if (existing) {
              existing.content.push(...result.content)
              if (result.status === "error") existing.status = "error"
            } else {
              toolResults.push(result)
            }
          }
        }
        textContent = textParts.join("\n")
      } else {
        textContent = extractText(content)
      }

      if (thinkingEnabled) textContent = appendThinkingHint(textContent)
      if (toolResults && lastToolUseOrder.length) toolResults = reorderToolResults(toolResults, lastToolUseOrder)

      const userCtx: Record<string, unknown> = { envState: { operatingSystem: "macos", currentWorkingDirectory: "/" } }
      if (toolResults) userCtx.toolResults = toolResults

      const uMsg: Record<string, unknown> = { content: textContent, userInputMessageContext: userCtx, origin: "KIRO_CLI" }
      if (images) uMsg.images = images
      raw.push({ userInputMessage: uMsg as any })
    } else if (msg.role === "assistant") {
      const textContent = extractText(msg.content)
      const entry: AmazonQHistoryMessage = {
        assistantResponseMessage: { content: textContent },
      }

      lastToolUseOrder = []
      if (Array.isArray(msg.content)) {
        const toolUses: AmazonQToolUse[] = []
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) {
            lastToolUseOrder.push(block.id)
            toolUses.push({ toolUseId: block.id, name: block.name ?? "", input: block.input ?? {} })
          }
        }
        if (toolUses.length) entry.assistantResponseMessage!.toolUses = toolUses
      }
      raw.push(entry)
    }
  }

  // Check if already alternating
  let prevRole: string | undefined
  let needsMerge = false
  for (const item of raw) {
    const role = "userInputMessage" in item ? "user" : "assistant"
    if (prevRole === role) { needsMerge = true; break }
    prevRole = role
  }
  if (!needsMerge) return raw

  // Merge consecutive user messages
  const history: AmazonQHistoryMessage[] = []
  let pendingUserMsgs: any[] = []
  for (const item of raw) {
    if ("userInputMessage" in item) {
      pendingUserMsgs.push(item.userInputMessage)
    } else {
      if (pendingUserMsgs.length) {
        history.push({ userInputMessage: mergeUserMessages(pendingUserMsgs) })
        pendingUserMsgs = []
      }
      history.push(item)
    }
  }
  if (pendingUserMsgs.length) {
    history.push({ userInputMessage: mergeUserMessages(pendingUserMsgs) })
  }
  return history
}

function mergeUserMessages(messages: any[]): any {
  if (messages.length === 1) return messages[0]
  const allContents: string[] = []
  let baseCtx: any = null
  let baseOrigin: string | undefined
  let baseModel: string | undefined
  for (const msg of messages) {
    if (!baseCtx) baseCtx = { ...(msg.userInputMessageContext ?? {}) }
    if (!baseOrigin) baseOrigin = msg.origin
    if (!baseModel) baseModel = msg.modelId
    const c = (msg.content as string || "").replace(THINKING_HINT, "").trim()
    if (c) allContents.push(c)
  }
  return {
    content: allContents.join("\n\n"),
    userInputMessageContext: baseCtx || {},
    origin: baseOrigin || "KIRO_CLI",
    modelId: baseModel,
  }
}

export function convertClaudeToAmazonQ(req: ClaudeRequestBody): AmazonQRequest {
  const conversationId = crypto.randomUUID()
  const thinkingEnabled = isThinkingEnabled(req.thinking)

  // Tools
  const aqTools: AmazonQTool[] = []
  const longDescTools: Array<{ name: string; full_description: string }> = []
  if (req.tools) {
    for (const t of req.tools) {
      if (t.description && t.description.length > 10240) longDescTools.push({ name: t.name, full_description: t.description })
      aqTools.push(convertTool(t))
    }
  }

  // Current message (last user message)
  const lastMsg = req.messages[req.messages.length - 1]
  let promptContent = ""
  let toolResults: AmazonQToolResult[] | undefined
  let hasToolResult = false
  let images: any

  if (lastMsg?.role === "user") {
    images = extractImages(lastMsg.content)
    if (Array.isArray(lastMsg.content)) {
      const textParts: string[] = []
      for (const block of lastMsg.content) {
        if (block.type === "text") textParts.push(block.text ?? "")
        else if (block.type === "thinking") textParts.push(wrapThinking(block.thinking ?? ""))
        else if (block.type === "tool_result") {
          hasToolResult = true
          if (!toolResults) toolResults = []
          const result = processToolResult(block)
          const existing = toolResults.find((r) => r.toolUseId === result.toolUseId)
          if (existing) {
            existing.content.push(...result.content)
            if (result.status === "error") existing.status = "error"
          } else {
            toolResults.push(result)
          }
        }
      }
      promptContent = textParts.join("\n")
    } else {
      promptContent = extractText(lastMsg.content)
    }
  }

  // Reorder tool_results by last assistant's tool_use order
  if (toolResults && req.messages.length >= 2) {
    const order: string[] = []
    for (let i = req.messages.length - 2; i >= 0; i--) {
      if (req.messages[i].role === "assistant" && Array.isArray(req.messages[i].content)) {
        for (const b of req.messages[i].content as ContentBlock[]) {
          if (b.type === "tool_use" && b.id) order.push(b.id)
        }
        break
      }
    }
    if (order.length) toolResults = reorderToolResults(toolResults, order)
  }

  // Context
  const userCtx: Record<string, unknown> = { envState: { operatingSystem: "macos", currentWorkingDirectory: "/" } }
  if (aqTools.length) userCtx.tools = aqTools
  if (toolResults) userCtx.toolResults = toolResults

  // Format content
  let formattedContent = ""
  if (hasToolResult && !promptContent) {
    formattedContent = ""
  } else {
    formattedContent = `--- CONTEXT ENTRY BEGIN ---\nCurrent time: ${getTimestamp()}\n--- CONTEXT ENTRY END ---\n\n--- USER MESSAGE BEGIN ---\n${promptContent}\n--- USER MESSAGE END ---`
  }

  if (longDescTools.length) {
    const docs = longDescTools.map((t) => `Tool: ${t.name}\nFull Description:\n${t.full_description}\n`).join("")
    formattedContent = `--- TOOL DOCUMENTATION BEGIN ---\n${docs}--- TOOL DOCUMENTATION END ---\n\n${formattedContent}`
  }

  if (req.system && formattedContent) {
    let sysText = ""
    if (typeof req.system === "string") sysText = req.system
    else if (Array.isArray(req.system)) sysText = req.system.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
    if (sysText) formattedContent = `--- SYSTEM PROMPT BEGIN ---\n${sysText}\n--- SYSTEM PROMPT END ---\n\n${formattedContent}`
  }

  if (thinkingEnabled) formattedContent = appendThinkingHint(formattedContent)

  const modelId = mapModelName(req.model)

  const userInputMsg: Record<string, unknown> = {
    content: formattedContent,
    userInputMessageContext: userCtx,
    origin: "KIRO_CLI",
    modelId,
  }
  if (images) userInputMsg.images = images

  // History
  const historyMsgs = req.messages.length > 1 ? req.messages.slice(0, -1) : []
  const aqHistory = processHistory(historyMsgs, thinkingEnabled)

  return {
    conversationState: {
      conversationId,
      history: aqHistory,
      currentMessage: { userInputMessage: userInputMsg as any },
      chatTriggerType: "MANUAL",
    },
  }
}
