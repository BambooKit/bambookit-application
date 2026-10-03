import { app, BrowserWindow, Notification } from "electron"
import { hostname } from "node:os"
import { BAMBOOKIT_CONFIG, isAuthConfigured } from "./config"
import { AuthError, SupabaseAuth, type AuthSession } from "./auth"
import { ApiError, BambooApi } from "./api"
import { DeviceIdentity } from "./identity"
import { OpenCodeBridge, type RemoteCommand, type SyncBatch } from "./bridge"
import { readState, writeState } from "./secure-store"
import { backoff } from "./sse"
import { write as writeLog } from "../logging"

export { BAMBOOKIT_CONFIG } from "./config"

export type LinkState = "disabled" | "offline" | "connecting" | "connected" | "error"

export interface BambooKitState {
  configured: boolean
  apiUrl: string
  account: AuthSession["user"] | null
  device: { id: string; name: string; fingerprint: string } | null
  api: LinkState
  realtime: LinkState
  opencode: LinkState
  pairedPhones: number
  error: string | null
}

const asMeta = (meta: unknown): Record<string, unknown> | undefined =>
  meta === undefined ? undefined : typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : { detail: meta }

const log = {
  log: (message: string, meta?: unknown) => writeLog("bambookit", message, asMeta(meta)),
  warn: (message: string, meta?: unknown) => writeLog("bambookit", message, asMeta(meta), "warn"),
}

/**
 * BambooKit supervisor: account session, device registration, realtime command channel and the
 * OpenCode bridge. Local OpenCode keeps working regardless of BambooKit connectivity.
 */
export class BambooKitSupervisor {
  private auth = new SupabaseAuth()
  private identity: DeviceIdentity | null = null
  private api: BambooApi | null = null
  private bridge: OpenCodeBridge | null = null
  private server: { url: string; username: string; password: string } | null = null
  private streamAbort: AbortController | null = null
  private streaming = false
  private handled = new Set<string>()
  private lastSeq: number | null = null
  private keepAlive: NodeJS.Timeout | null = null
  private state: BambooKitState = {
    configured: isAuthConfigured(),
    apiUrl: BAMBOOKIT_CONFIG.apiUrl,
    account: null,
    device: null,
    api: "disabled",
    realtime: "disabled",
    opencode: "connecting",
    pairedPhones: 0,
    error: null,
  }

  getState(): BambooKitState {
    return this.state
  }

  async init(serverUrl: string, serverUsername: string | undefined, serverPassword: string | undefined): Promise<void> {
    this.server = { url: serverUrl, username: serverUsername || "opencode", password: serverPassword || "" }
    try {
      this.identity = await DeviceIdentity.load()
      this.api = new BambooApi(this.auth, this.identity)
      this.lastSeq = (await readState<{ seq: number }>("realtime"))?.seq ?? null
      this.auth.onSignedOut = (reason) => log.warn("signed out", { reason })
      // The hosted API sleeps after ~15 min idle on the free plan; keep it awake while the app runs.
      this.keepAlive = setInterval(() => void fetch(`${BAMBOOKIT_CONFIG.apiUrl}/health`).catch(() => undefined), 10 * 60_000)
      this.auth.onChange((session) => {
        this.update({ account: session?.user ?? null })
        if (!session) this.disconnect()
      })
      const session = await this.auth.restore()
      this.update({ account: session?.user ?? null })
      if (session) void this.connect()
    } catch (err: any) {
      log.warn("supervisor init failed", err?.message)
      this.update({ error: err?.message ?? String(err) })
    }
  }

  // ------------------------------------------------------------------ account

  async signIn(email: string, password: string) {
    const session = await this.auth.signInWithPassword(email, password)
    void this.connect()
    return session.user
  }

  async signUp(email: string, password: string, name?: string) {
    const session = await this.auth.signUp(email, password, name)
    if (session) void this.connect()
    return { user: session?.user ?? null, confirmationRequired: !session }
  }

  async signInWithGoogle() {
    const session = await this.auth.signInWithGoogle()
    void this.connect()
    return session.user
  }

  resendConfirmation(email: string) {
    return this.auth.resendConfirmation(email)
  }

  sendPasswordReset(email: string) {
    return this.auth.sendPasswordReset(email)
  }

  async signOut() {
    this.disconnect()
    await this.auth.signOut()
    this.update({ device: null, pairedPhones: 0, error: null })
  }

  // ------------------------------------------------------------------ devices & pairing

  async createPairingToken(): Promise<{ uri: string; expiresAt: string; ttlSeconds: number }> {
    this.requireDevice()
    const res = await this.api!.request("POST", "/v1/pairing/tokens", {}, { signed: true })
    return { uri: res.data.uri, expiresAt: res.data.expiresAt, ttlSeconds: res.data.ttlSeconds }
  }

  async listDevices() {
    const res = await this.api!.request("GET", "/v1/devices")
    return res.data as any[]
  }

  async unlinkDevice(otherDeviceId: string) {
    this.requireDevice()
    await this.api!.request("POST", `/v1/devices/${this.state.device!.id}/unlink`, { otherDeviceId })
    await this.refreshDevice()
  }

  async revokeDevice(deviceId: string) {
    await this.api!.request("POST", `/v1/devices/${deviceId}/revoke`, {})
    await this.refreshDevice()
  }

  async renameDevice(name: string) {
    this.requireDevice()
    await this.api!.request("PATCH", `/v1/devices/${this.state.device!.id}`, { name })
    await this.refreshDevice()
  }

  // ------------------------------------------------------------------ connection lifecycle

  private async connect() {
    if (!this.api || !this.identity || !this.auth.current) return
    this.update({ api: "connecting", error: null })
    let attempt = 0
    while (this.auth.current) {
      try {
        const res = await this.api.request(
          "POST",
          "/v1/devices/register",
          { kind: "desktop", name: deviceName(), platform: process.platform === "win32" ? "windows" : process.platform, appVersion: app.getVersion(), publicKey: this.identity.publicKeyPem },
          { signed: true },
        )
        this.api.deviceId = res.data.id
        this.applyDevice(res.data)
        this.update({ api: "connected" })
        break
      } catch (err: any) {
        const fatal = err instanceof ApiError && (err.status === 401 || err.status === 403)
        this.update({ api: fatal ? "error" : "offline", error: err.message })
        if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") return
        if (fatal && err.status === 403) return
        await sleep(backoff(attempt++, 2000, 60_000))
      }
    }
    if (!this.auth.current) return
    this.startBridge()
    void this.streamLoop()
  }

  private disconnect() {
    this.streaming = false
    this.streamAbort?.abort()
    this.bridge?.stop()
    this.bridge = null
    if (this.api) this.api.deviceId = null
    this.update({ api: "disabled", realtime: "disabled" })
  }

  private startBridge() {
    if (this.bridge || !this.server) return
    this.bridge = new OpenCodeBridge(this.server, (batch) => this.publish(batch), log, (connected) => {
      this.update({ opencode: connected ? "connected" : "connecting" })
    })
    this.bridge.start()
  }

  private async publish(batch: SyncBatch) {
    if (!this.api?.deviceId) return
    if (!Object.values(batch).some((v) => (Array.isArray(v) ? v.length > 0 : v != null))) return
    await this.api.request("POST", "/v1/sync", batch, { signed: true })
  }

  private async streamLoop() {
    if (this.streaming) return
    this.streaming = true
    let attempt = 0
    let reregister = false
    while (this.streaming && this.auth.current && this.api?.deviceId) {
      this.streamAbort = new AbortController()
      this.update({ realtime: "connecting" })
      try {
        await this.api.stream(this.lastSeq, this.streamAbort.signal, (msg) => {
          if (msg.event === "ready") {
            attempt = 0
            this.update({ realtime: "connected", api: "connected", error: null })
            void this.onStreamReady()
            return
          }
          if (msg.event === "ping") return
          const event = JSON.parse(msg.data)
          // Live-only events (relay requests) have seq -1 and must not move the resume position.
          if (typeof event.seq === "number" && event.seq >= 0) {
            this.lastSeq = event.seq
            void writeState("realtime", { seq: event.seq })
          }
          void this.onEvent(event)
        })
      } catch (err: any) {
        if (!this.streaming) break
        log.warn("realtime stream error", err?.message)
        this.update({ realtime: "offline", error: err?.message ?? String(err) })
        if (err?.status === 403) {
          this.streaming = false
          // The API no longer knows this PC (e.g. its database was reset): register again with
          // the same device key instead of staying disconnected. Revoked devices stay revoked.
          if (String(err?.message).includes("DEVICE_NOT_OWNED")) reregister = true
          else this.update({ realtime: "error" })
          break
        }
      }
      if (!this.streaming) break
      this.update({ realtime: "offline" })
      await sleep(backoff(attempt++, 1000, 30_000))
    }
    this.streaming = false
    if (reregister && this.auth.current) {
      log.log("bambookit device unknown to the API; registering again")
      this.bridge?.stop()
      this.bridge = null
      this.lastSeq = null
      await this.connect()
    }
  }

  private async onStreamReady() {
    // Catch up on anything queued while we were offline, then resend local state.
    try {
      const pending = await this.api!.request("GET", `/v1/devices/${this.api!.deviceId}/commands`, undefined, { signed: true })
      for (const command of pending.data) await this.runCommand(command)
    } catch (err: any) {
      log.warn("fetch pending commands failed", err?.message)
    }
    await this.bridge?.resync().catch((err) => log.warn("resync failed", String(err)))
  }

  private async onEvent(event: { type: string; deviceId: string | null; payload: any }) {
    switch (event.type) {
      case "command.created":
        if (event.deviceId === this.api?.deviceId) await this.runCommand(event.payload)
        break
      case "relay.request":
        if (event.deviceId === this.api?.deviceId) await this.answerRelay(event.payload)
        break
      case "pairing.completed":
        if (event.deviceId === this.api?.deviceId) {
          this.applyDevice(event.payload.desktop)
          broadcast("bambookit-event", { type: "pairing.completed", mobile: event.payload.mobile })
          if (Notification.isSupported()) new Notification({ title: "BambooKit", body: `${event.payload.mobile.name} is now connected` }).show()
        }
        break
      case "device.revoked":
        if (event.deviceId === this.api?.deviceId) {
          this.disconnect()
          this.update({ api: "error", error: "This desktop was revoked from your BambooKit account." })
        } else await this.refreshDevice()
        break
      case "device.unlinked":
      case "device.updated":
        await this.refreshDevice()
        break
    }
  }

  /** A phone or the website asked for a session's chat or changes; answer straight from this PC. */
  private async answerRelay(request: { id: string; kind: string; params: any }) {
    if (!this.api || !request?.id) return
    let body: { data?: unknown; error?: string }
    try {
      if (!this.bridge) throw new Error("The agent engine on this PC is not running")
      body = { data: await this.bridge.answerRelay(request.kind, request.params) }
    } catch (err: any) {
      body = { error: String(err?.message ?? err).slice(0, 1000) }
    }
    await this.api.request("POST", `/v1/relay/${request.id}/response`, body, { signed: true }).catch((err) => log.warn("relay response failed", err?.message))
  }

  private async runCommand(command: RemoteCommand) {
    if (this.handled.has(command.id)) return
    this.handled.add(command.id)
    if (this.handled.size > 1000) this.handled.delete(this.handled.values().next().value!)
    log.log("remote command", { id: command.id, type: command.type })
    let report: { status: "SUCCEEDED" | "FAILED"; result?: unknown; error?: string }
    try {
      if (!this.bridge) throw new Error("The BambooKit agent engine is not running")
      report = { status: "SUCCEEDED", result: await this.bridge.execute(command) }
    } catch (err: any) {
      report = { status: "FAILED", error: String(err?.message ?? err).slice(0, 2000) }
    }
    try {
      await this.api!.request("POST", `/v1/commands/${command.id}/result`, report, { signed: true })
    } catch (err: any) {
      if (!(err instanceof ApiError && err.status === 409)) log.warn("report command result failed", err?.message)
    }
  }

  private async refreshDevice() {
    if (!this.api?.deviceId) return
    try {
      const res = await this.api.request("GET", `/v1/devices/${this.api.deviceId}`)
      this.applyDevice(res.data)
    } catch {}
  }

  private applyDevice(device: any) {
    this.update({
      device: { id: device.id, name: device.name, fingerprint: this.identity?.fingerprint ?? "" },
      pairedPhones: (device.linkedDevices ?? []).filter((d: any) => d.kind === "mobile").length,
    })
  }

  private requireDevice() {
    if (!this.api?.deviceId || !this.state.device) throw new Error("This desktop is not connected to BambooKit yet")
  }

  private update(patch: Partial<BambooKitState>) {
    this.state = { ...this.state, ...patch }
    broadcast("bambookit-state", this.state)
  }

  stop(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.disconnect()
  }
}

function deviceName() {
  const host = hostname()
  return host ? `${host} (Windows)`.slice(0, 100) : "Windows PC"
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export const bambookitSupervisor = new BambooKitSupervisor()
