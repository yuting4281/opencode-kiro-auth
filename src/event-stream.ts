import type { EventStreamMessage } from "./types.js"

/**
 * AWS Event Stream binary parser.
 * Format: [4B total_len][4B headers_len][4B prelude_crc][headers][payload][4B msg_crc]
 */
export class AwsEventStreamParser {
  private buf = new Uint8Array(0)

  feed(data: Uint8Array): EventStreamMessage[] {
    // Append new data to buffer
    const merged = new Uint8Array(this.buf.length + data.length)
    merged.set(this.buf)
    merged.set(data, this.buf.length)
    this.buf = merged

    const events: EventStreamMessage[] = []
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)

    let offset = 0
    while (offset + 12 <= this.buf.length) {
      const totalLen = view.getUint32(offset)
      const headersLen = view.getUint32(offset + 4)

      if (totalLen < 16 || headersLen > totalLen) {
        offset++
        continue
      }

      if (offset + totalLen > this.buf.length) break

      const headersStart = offset + 12
      const headersRaw = this.buf.slice(headersStart, headersStart + headersLen)
      const payloadStart = headersStart + headersLen
      const payloadEnd = offset + totalLen - 4
      const payload = this.buf.slice(payloadStart, payloadEnd)

      events.push({
        headers: parseEventHeaders(headersRaw),
        payload,
      })

      offset += totalLen
    }

    // Keep remaining bytes
    this.buf = this.buf.slice(offset)
    return events
  }
}

function parseEventHeaders(raw: Uint8Array): Record<string, unknown> {
  const headers: Record<string, unknown> = {}
  let i = 0
  const n = raw.length

  while (i < n) {
    if (i + 1 > n) break
    const nameLen = raw[i]
    i++
    if (i + nameLen + 1 > n) break
    const name = new TextDecoder().decode(raw.slice(i, i + nameLen))
    i += nameLen
    const htype = raw[i]
    i++

    if (htype === 0) {
      headers[name] = true
    } else if (htype === 1) {
      headers[name] = false
    } else if (htype === 2) {
      if (i + 1 > n) break
      headers[name] = raw[i]
      i += 1
    } else if (htype === 3) {
      if (i + 2 > n) break
      headers[name] = new DataView(raw.buffer, raw.byteOffset + i, 2).getInt16(0)
      i += 2
    } else if (htype === 4) {
      if (i + 4 > n) break
      headers[name] = new DataView(raw.buffer, raw.byteOffset + i, 4).getInt32(0)
      i += 4
    } else if (htype === 5) {
      if (i + 8 > n) break
      headers[name] = Number(new DataView(raw.buffer, raw.byteOffset + i, 8).getBigInt64(0))
      i += 8
    } else if (htype === 6) {
      if (i + 2 > n) break
      const len = new DataView(raw.buffer, raw.byteOffset + i, 2).getUint16(0)
      i += 2
      if (i + len > n) break
      headers[name] = raw.slice(i, i + len)
      i += len
    } else if (htype === 7) {
      if (i + 2 > n) break
      const len = new DataView(raw.buffer, raw.byteOffset + i, 2).getUint16(0)
      i += 2
      if (i + len > n) break
      headers[name] = new TextDecoder().decode(raw.slice(i, i + len))
      i += len
    } else if (htype === 8) {
      if (i + 8 > n) break
      headers[name] = Number(new DataView(raw.buffer, raw.byteOffset + i, 8).getBigUint64(0))
      i += 8
    } else {
      break
    }
  }

  return headers
}
