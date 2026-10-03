export interface SseMessage {
  id?: string
  event: string
  data: string
}

/**
 * Minimal Server-Sent Events reader over fetch. Resolves when the stream ends; throws on HTTP
 * errors. Callers own reconnection.
 */
export async function readSse(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const res = await fetch(url, { ...init, headers: { Accept: "text/event-stream", ...(init.headers ?? {}) } })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    const err = new Error(`SSE ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let id: string | undefined
  let event = "message"
  let data: string[] = []

  const dispatch = () => {
    if (data.length) onMessage({ id, event, data: data.join("\n") })
    event = "message"
    data = []
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1))
      if (line === "") {
        dispatch()
        continue
      }
      if (line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      const raw = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "data") data.push(raw)
      else if (field === "event") event = raw
      else if (field === "id") id = raw
    }
  }
  dispatch()
}

/** Exponential backoff with jitter, capped. */
export function backoff(attempt: number, base = 1000, max = 30_000): number {
  const exp = Math.min(max, base * 2 ** Math.min(attempt, 10))
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}
