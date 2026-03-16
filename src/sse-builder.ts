function sseFormat(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

export function buildMessageStart(conversationId: string, model: string, inputTokens: number): string {
  return sseFormat("message_start", {
    type: "message_start",
    message: {
      id: conversationId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
}

export function buildContentBlockStart(index: number, blockType: string): string {
  let contentBlock: Record<string, unknown>
  if (blockType === "text") {
    contentBlock = { type: "text", text: "" }
  } else if (blockType === "thinking") {
    contentBlock = { type: "thinking", thinking: "" }
  } else {
    contentBlock = { type: blockType }
  }
  return sseFormat("content_block_start", {
    type: "content_block_start",
    index,
    content_block: contentBlock,
  })
}

export function buildContentBlockDelta(
  index: number,
  text: string,
  deltaType = "text_delta",
  fieldName = "text",
): string {
  const delta: Record<string, unknown> = { type: deltaType }
  if (fieldName) delta[fieldName] = text
  return sseFormat("content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  })
}

export function buildContentBlockStop(index: number): string {
  return sseFormat("content_block_stop", { type: "content_block_stop", index })
}

export function buildPing(): string {
  return sseFormat("ping", { type: "ping" })
}

export function buildMessageStop(inputTokens: number, outputTokens: number, stopReason?: string): string {
  const deltaEvent = sseFormat("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
  const stopEvent = sseFormat("message_stop", { type: "message_stop" })
  return deltaEvent + stopEvent
}

export function buildToolUseStart(index: number, toolUseId: string, toolName: string): string {
  return sseFormat("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
  })
}

export function buildToolUseInputDelta(index: number, inputJsonDelta: string): string {
  return sseFormat("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: inputJsonDelta },
  })
}
