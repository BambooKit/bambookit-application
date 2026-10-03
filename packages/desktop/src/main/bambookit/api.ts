import { BAMBOOKIT_CONFIG } from "./config"
import type { SupabaseAuth } from "./auth"
import type { DeviceIdentity } from "./identity"
import { readSse, type SseMessage } from "./sse"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

/** HTTP client for bambookit-api. Device-channel requests are signed with the Ed25519 identity. */
export class BambooApi {
  deviceId: string | null = null

  constructor(
    private readonly auth: SupabaseAuth,
    private readonly identity: DeviceIdentity,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, opts: { signed?: boolean } = {}): Promise<T> {
    const token = await this.auth.accessToken()
    const text = body === undefined ? "" : JSON.stringify(body)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (text) headers["Content-Type"] = "application/json"
    if (opts.signed) {
      if (this.deviceId) headers["X-BK-Device-Id"] = this.deviceId
      Object.assign(headers, this.identity.signRequest(method, path, text))
    }
    let res: Response
    try {
      res = await fetch(`${BAMBOOKIT_CONFIG.apiUrl}${path}`, { method, headers, body: text || undefined })
    } catch (err: any) {
      throw new ApiError(`BambooKit API unreachable (${BAMBOOKIT_CONFIG.apiUrl}): ${err.message}`, 0, "NETWORK")
    }
    const raw = await res.text()
    let json: any = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {}
    if (!res.ok) {
      throw new ApiError(json?.error?.message ?? `BambooKit API error ${res.status}`, res.status, json?.error?.code ?? `HTTP_${res.status}`)
    }
    return json as T
  }

  /** Signed realtime stream for this desktop. Resolves when the stream closes. */
  async stream(after: number | null, signal: AbortSignal, onMessage: (msg: SseMessage) => void): Promise<void> {
    const token = await this.auth.accessToken()
    const path = `/v1/realtime/stream${after !== null ? `?after=${after}` : ""}`
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-BK-Device-Id": this.deviceId! }
    Object.assign(headers, this.identity.signRequest("GET", path, ""))
    await readSse(`${BAMBOOKIT_CONFIG.apiUrl}${path}`, { signal, headers }, onMessage)
  }
}
