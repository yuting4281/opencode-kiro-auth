import { convertClaudeToAmazonQ, type ClaudeRequestBody } from "./converter.js"
import { AwsEventStreamParser } from "./event-stream.js"
import { ClaudeStreamHandler } from "./stream.js"
import { AMAZON_Q_URL, AMAZON_Q_HEADERS, mapModelName } from "./models.js"

function estimateInputTokens(body: ClaudeRequestBody): number {
  let chars = 0
  if (typeof body.system === "string") chars += body.system.length
  else if (Array.isArray(body.system)) {
    for (const b of body.system) if (b.text) chars += b.text.length
  }
  for (const msg of body.messages) {
    if (typeof msg.content === "string") chars += msg.content.length
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.text) chars += b.text.length
        if (b.thinking) chars += b.thinking.length
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4))
}

export function createCustomFetch(accessToken: string): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? "GET"

    // Only intercept POST to Anthropic messages endpoint

    if (method !== "POST" || !url.endsWith("/messages")) {
      return globalThis.fetch(input, init)
    }


    const claudeBody: ClaudeRequestBody = JSON.parse(init?.body as string)
    const isStream = claudeBody.stream === true
    const aqRequest = convertClaudeToAmazonQ(claudeBody)


    const aqResp = await globalThis.fetch(AMAZON_Q_URL, {
      method: "POST",
      headers: {
        ...AMAZON_Q_HEADERS,
        authorization: `Bearer ${accessToken}`,
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify(aqRequest),
    })


    if (!aqResp.ok) {
      const text = await aqResp.text()

      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: text } }), {
        status: aqResp.status,
        headers: { "content-type": "application/json" },
      })
    }

    if (!isStream) {
      // Non-streaming: collect full response
      return collectNonStreamResponse(aqResp, claudeBody)
    }

    // Streaming: pipe AWS Event Stream → Anthropic SSE
    const model = mapModelName(claudeBody.model)
    const inputTokens = estimateInputTokens(claudeBody)
    const handler = new ClaudeStreamHandler(model, inputTokens)
    const parser = new AwsEventStreamParser()

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const reader = aqResp.body!.getReader()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const events = parser.feed(value)
            for (const evt of events) {
              const payloadText = new TextDecoder().decode(evt.payload)
              let parsed: Record<string, unknown>
              try {
                parsed = JSON.parse(payloadText)
              } catch {
                continue
              }

              // Check for exceptions
              const exType = evt.headers[":exception-type"] as string | undefined
              if (exType) {
                const msg = (parsed as any).message ?? exType
                controller.enqueue(encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`
                ))
                controller.close()
                return
              }

              const eventType = evt.headers[":event-type"] as string | undefined
              if (!eventType) continue

              // Map Amazon Q events
              const aqEvent = parsed as Record<string, unknown>
              for (const sseChunk of mapAqEvent(eventType, aqEvent, handler)) {
                controller.enqueue(encoder.encode(sseChunk))
              }
            }
          }

          // Flush remaining
          for (const sseChunk of handler.finish()) {
            controller.enqueue(encoder.encode(sseChunk))
          }
        } catch (err) {
          controller.enqueue(encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } })}\n\n`
          ))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }
}

function* mapAqEvent(
  eventType: string,
  payload: Record<string, unknown>,
  handler: ClaudeStreamHandler,
): Generator<string> {
  if (eventType === "messageMetadataEvent") {
    yield* handler.handleEvent("initial-response", payload)
  } else if (eventType === "assistantResponseEvent") {
    yield* handler.handleEvent("assistantResponseEvent", payload)
  } else if (eventType === "codeEvent") {
    yield* handler.handleEvent("assistantResponseEvent", { content: payload.content })
  } else if (eventType === "toolUseEvent") {
    yield* handler.handleEvent("toolUseEvent", payload)
  } else if (eventType === "assistantResponseCompleteEvent") {
    yield* handler.handleEvent("assistantResponseEnd", payload)
  }
}

async function collectNonStreamResponse(aqResp: Response, claudeBody: ClaudeRequestBody): Promise<Response> {
  const model = mapModelName(claudeBody.model)
  const inputTokens = estimateInputTokens(claudeBody)
  const handler = new ClaudeStreamHandler(model, inputTokens)
  const parser = new AwsEventStreamParser()

  const chunks: string[] = []
  const reader = aqResp.body!.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const events = parser.feed(value)
    for (const evt of events) {
      const payloadText = new TextDecoder().decode(evt.payload)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(payloadText)
      } catch {
        continue
      }

      const eventType = evt.headers[":event-type"] as string | undefined
      if (!eventType) continue

      for (const sseChunk of mapAqEvent(eventType, parsed, handler)) {
        chunks.push(sseChunk)
      }
    }
  }

  for (const sseChunk of handler.finish()) {
    chunks.push(sseChunk)
  }

  // Parse SSE chunks to extract the full response content
  const contentBlocks: any[] = []
  let stopReason = "end_turn"
  let outputTokens = 0

  for (const chunk of chunks) {
    const lines = chunk.split("\n")
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (data.type === "content_block_start") {
          contentBlocks.push({ ...data.content_block })
        } else if (data.type === "content_block_delta") {
          const block = contentBlocks[data.index]
          if (block && data.delta) {
            if (data.delta.type === "text_delta") block.text = (block.text || "") + data.delta.text
            else if (data.delta.type === "thinking_delta") block.thinking = (block.thinking || "") + data.delta.thinking
            else if (data.delta.type === "input_json_delta") block._input_json = (block._input_json || "") + data.delta.partial_json
          }
        } else if (data.type === "message_delta") {
          stopReason = data.delta?.stop_reason ?? stopReason
          outputTokens = data.usage?.output_tokens ?? outputTokens
        }
      } catch {}
    }
  }

  // Parse tool_use input JSON
  for (const block of contentBlocks) {
    if (block.type === "tool_use" && block._input_json) {
      try { block.input = JSON.parse(block._input_json) } catch { block.input = {} }
      delete block._input_json
    }
  }

  const responseBody = {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
