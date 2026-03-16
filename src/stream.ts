import {
  buildMessageStart,
  buildContentBlockStart,
  buildContentBlockDelta,
  buildContentBlockStop,
  buildPing,
  buildMessageStop,
  buildToolUseStart,
  buildToolUseInputDelta,
} from "./sse-builder.js"

const THINKING_START_TAG = "<thinking>"
const THINKING_END_TAG = "</thinking>"

function pendingTagSuffix(buffer: string, tag: string): number {
  if (!buffer || !tag) return 0
  const maxLen = Math.min(buffer.length, tag.length - 1)
  for (let length = maxLen; length > 0; length--) {
    if (buffer.slice(-length) === tag.slice(0, length)) return length
  }
  return 0
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export class ClaudeStreamHandler {
  private model: string
  private inputTokens: number
  private responseBuffer: string[] = []
  private contentBlockIndex = -1
  private contentBlockStarted = false
  private contentBlockStartSent = false
  private contentBlockStopSent = false
  private messageStartSent = false
  private conversationId: string | undefined

  private currentToolUse: { toolUseId: string; name: string } | null = null
  private toolInputBuffer: string[] = []
  private processedToolUseIds = new Set<string>()
  private allToolInputs: string[] = []
  private hasToolUse = false

  private inThinkBlock = false
  private thinkBuffer = ""
  private pendingStartTagChars = 0
  private responseEnded = false

  constructor(model: string, inputTokens = 0, conversationId?: string) {
    this.model = model
    this.inputTokens = inputTokens
    this.conversationId = conversationId
  }

  *handleEvent(eventType: string, payload: Record<string, unknown>): Generator<string> {
    if (this.responseEnded) return

    if (eventType === "initial-response") {
      if (!this.messageStartSent) {
        const convId = (payload.conversationId as string) || this.conversationId || crypto.randomUUID()
        this.conversationId = convId
        yield buildMessageStart(convId, this.model, this.inputTokens)
        this.messageStartSent = true
        yield buildPing()
      }
    } else if (eventType === "assistantResponseEvent") {
      const content = (payload.content as string) || ""

      if (this.currentToolUse && !this.contentBlockStopSent) {
        yield buildContentBlockStop(this.contentBlockIndex)
        this.contentBlockStopSent = true
        this.currentToolUse = null
      }

      if (content) {
        this.thinkBuffer += content
        while (this.thinkBuffer) {
          if (this.pendingStartTagChars > 0) {
            if (this.thinkBuffer.length < this.pendingStartTagChars) {
              this.pendingStartTagChars -= this.thinkBuffer.length
              this.thinkBuffer = ""
              break
            }
            this.thinkBuffer = this.thinkBuffer.slice(this.pendingStartTagChars)
            this.pendingStartTagChars = 0
            if (!this.thinkBuffer) break
            continue
          }

          if (!this.inThinkBlock) {
            const thinkStart = this.thinkBuffer.indexOf(THINKING_START_TAG)
            if (thinkStart === -1) {
              const pending = pendingTagSuffix(this.thinkBuffer, THINKING_START_TAG)
              if (pending === this.thinkBuffer.length && pending > 0) {
                if (this.contentBlockStartSent) {
                  yield buildContentBlockStop(this.contentBlockIndex)
                  this.contentBlockStopSent = true
                  this.contentBlockStartSent = false
                }
                this.contentBlockIndex++
                yield buildContentBlockStart(this.contentBlockIndex, "thinking")
                this.contentBlockStartSent = true
                this.contentBlockStarted = true
                this.contentBlockStopSent = false
                this.inThinkBlock = true
                this.pendingStartTagChars = THINKING_START_TAG.length - pending
                this.thinkBuffer = ""
                break
              }
              const emitLen = this.thinkBuffer.length - pending
              if (emitLen <= 0) break
              const textChunk = this.thinkBuffer.slice(0, emitLen)
              if (textChunk) {
                if (!this.contentBlockStartSent) {
                  this.contentBlockIndex++
                  yield buildContentBlockStart(this.contentBlockIndex, "text")
                  this.contentBlockStartSent = true
                  this.contentBlockStarted = true
                  this.contentBlockStopSent = false
                }
                this.responseBuffer.push(textChunk)
                yield buildContentBlockDelta(this.contentBlockIndex, textChunk)
              }
              this.thinkBuffer = this.thinkBuffer.slice(emitLen)
            } else {
              const beforeText = this.thinkBuffer.slice(0, thinkStart)
              if (beforeText) {
                if (!this.contentBlockStartSent) {
                  this.contentBlockIndex++
                  yield buildContentBlockStart(this.contentBlockIndex, "text")
                  this.contentBlockStartSent = true
                  this.contentBlockStarted = true
                  this.contentBlockStopSent = false
                }
                this.responseBuffer.push(beforeText)
                yield buildContentBlockDelta(this.contentBlockIndex, beforeText)
              }
              this.thinkBuffer = this.thinkBuffer.slice(thinkStart + THINKING_START_TAG.length)

              if (this.contentBlockStartSent) {
                yield buildContentBlockStop(this.contentBlockIndex)
                this.contentBlockStopSent = true
                this.contentBlockStartSent = false
              }
              this.contentBlockIndex++
              yield buildContentBlockStart(this.contentBlockIndex, "thinking")
              this.contentBlockStartSent = true
              this.contentBlockStarted = true
              this.contentBlockStopSent = false
              this.inThinkBlock = true
              this.pendingStartTagChars = 0
            }
          } else {
            const thinkEnd = this.thinkBuffer.indexOf(THINKING_END_TAG)
            if (thinkEnd === -1) {
              const pending = pendingTagSuffix(this.thinkBuffer, THINKING_END_TAG)
              const emitLen = this.thinkBuffer.length - pending
              if (emitLen <= 0) break
              const thinkingChunk = this.thinkBuffer.slice(0, emitLen)
              if (thinkingChunk) {
                yield buildContentBlockDelta(this.contentBlockIndex, thinkingChunk, "thinking_delta", "thinking")
              }
              this.thinkBuffer = this.thinkBuffer.slice(emitLen)
            } else {
              const thinkingChunk = this.thinkBuffer.slice(0, thinkEnd)
              if (thinkingChunk) {
                yield buildContentBlockDelta(this.contentBlockIndex, thinkingChunk, "thinking_delta", "thinking")
              }
              this.thinkBuffer = this.thinkBuffer.slice(thinkEnd + THINKING_END_TAG.length)
              yield buildContentBlockStop(this.contentBlockIndex)
              this.contentBlockStopSent = true
              this.contentBlockStartSent = false
              this.inThinkBlock = false
            }
          }
        }
      }
    } else if (eventType === "toolUseEvent") {
      const toolUseId = payload.toolUseId as string | undefined
      const toolName = payload.name as string | undefined
      const toolInput = payload.input
      const isStop = payload.stop as boolean

      if (toolUseId && this.processedToolUseIds.has(toolUseId) && !this.currentToolUse) return

      if (toolUseId && toolName && !this.currentToolUse) {
        if (this.contentBlockStartSent && !this.contentBlockStopSent) {
          yield buildContentBlockStop(this.contentBlockIndex)
          this.contentBlockStopSent = true
        }
        this.processedToolUseIds.add(toolUseId)
        this.contentBlockIndex++
        yield buildToolUseStart(this.contentBlockIndex, toolUseId, toolName)
        this.contentBlockStarted = true
        this.currentToolUse = { toolUseId, name: toolName }
        this.toolInputBuffer = []
        this.contentBlockStopSent = false
        this.contentBlockStartSent = true
        this.hasToolUse = true
      }

      if (this.currentToolUse && toolInput) {
        const fragment = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput)
        this.toolInputBuffer.push(fragment)
        yield buildToolUseInputDelta(this.contentBlockIndex, fragment)
      }

      if (isStop && this.currentToolUse) {
        this.allToolInputs.push(this.toolInputBuffer.join(""))
        yield buildContentBlockStop(this.contentBlockIndex)
        this.contentBlockStopSent = true
        this.contentBlockStarted = false
        this.contentBlockStartSent = false
        this.currentToolUse = null
        this.toolInputBuffer = []
      }
    } else if (eventType === "assistantResponseEnd") {
      if (this.contentBlockStarted && !this.contentBlockStopSent) {
        yield buildContentBlockStop(this.contentBlockIndex)
        this.contentBlockStopSent = true
      }
      this.responseEnded = true
      const fullText = this.responseBuffer.join("")
      const fullToolInput = this.allToolInputs.join("")
      const outputTokens = estimateTokens(fullText) + estimateTokens(fullToolInput)
      const stopReason = this.hasToolUse ? "tool_use" : "end_turn"
      yield buildMessageStop(this.inputTokens, outputTokens, stopReason)
    }
  }

  *finish(): Generator<string> {
    if (this.responseEnded) return

    if (this.thinkBuffer) {
      if (this.inThinkBlock) {
        yield buildContentBlockDelta(this.contentBlockIndex, this.thinkBuffer, "thinking_delta", "thinking")
      } else {
        if (!this.contentBlockStartSent) {
          this.contentBlockIndex++
          yield buildContentBlockStart(this.contentBlockIndex, "text")
          this.contentBlockStartSent = true
          this.contentBlockStarted = true
          this.contentBlockStopSent = false
        }
        this.responseBuffer.push(this.thinkBuffer)
        yield buildContentBlockDelta(this.contentBlockIndex, this.thinkBuffer)
      }
      this.thinkBuffer = ""
    }

    if (this.contentBlockStarted && !this.contentBlockStopSent) {
      yield buildContentBlockStop(this.contentBlockIndex)
    }

    const fullText = this.responseBuffer.join("")
    const fullToolInput = this.allToolInputs.join("")
    const outputTokens = estimateTokens(fullText) + estimateTokens(fullToolInput)
    const stopReason = this.hasToolUse ? "tool_use" : "end_turn"
    yield buildMessageStop(this.inputTokens, outputTokens, stopReason)
  }
}
