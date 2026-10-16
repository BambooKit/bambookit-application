import { app, BrowserWindow, clipboard, Notification, shell } from "electron"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { hostname } from "node:os"
import { BAMBOOKIT_CONFIG, isAuthConfigured } from "./config"
import { AuthError, SupabaseAuth, type AuthSession } from "./auth"
import { ApiError, BambooApi } from "./api"
import { DeviceIdentity } from "./identity"
import { OpenCodeBridge, type RemoteCommand, type SyncBatch } from "./bridge"
import { readState, writeState } from "./secure-store"
import {
  PcSettingsStore,
  POWER_COUNTDOWN_SECONDS,
  closeAllTerminals,
  closeTerminal,
  openTerminal,
  resizeTerminal,
  runPowerAction,
  writeTerminal,
  type ApprovalMode,
  type PcSettings,
  type PowerAction,
} from "./pc-control"
import { backoff } from "./sse"
import { write as writeLog } from "../logging"

export { BAMBOOKIT_CONFIG } from "./config"

export type LinkState = "disabled" | "offline" | "connecting" | "connected" | "error"

/** What this desktop implements; the API only sends phones' requests a PC can answer (lib/compat.ts there). */
const CAPABILITIES = [
  "relay.transcript",
  "relay.changes",
  "relay.filemap",
  "relay.diagram",
  "relay.tree",
  "relay.file",
  "session-stats",
  "approval-modes",
  "keep-awake.remote",
  "remote-terminal",
  "remote-power",
  "continue-on-pc",
]
const PROTOCOL = 2
/** While the plan's PC limit blocks registration, try again this often (it reconnects by itself after an upgrade). */
const PLAN_LIMIT_RETRY_MS = 2 * 60_000

export interface PlanLimit {
  message: string
  max: number | null
  used: number | null
  upgradeUrl: string | null
}

export interface PendingPower {
  id: string
  action: PowerAction
  /** Epoch ms when the action runs unless cancelled. */
  runsAt: number
}

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
  settings: PcSettings
  planLimit: PlanLimit | null
  pendingPower: PendingPower | null
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
  private pc = new PcSettingsStore()
  private powerTimer: NodeJS.Timeout | null = null
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
    settings: { approvalMode: "ask", keepAwake: false, allowRemoteControl: false, phoneChatAnySession: true },
    planLimit: null,
    pendingPower: null,
  }

  getState(): BambooKitState {
    return this.state
  }

  async init(serverUrl: string, serverUsername: string | undefined, serverPassword: string | undefined): Promise<void> {
    this.server = { url: serverUrl, username: serverUsername || "opencode", password: serverPassword || "" }
    try {
      await this.pc.load()
      this.update({ settings: this.pc.get() })
      this.pc.onChange((settings) => {
        this.update({ settings })
        this.bridge?.applyApprovalMode()
        this.bridge?.setChatAnySession(settings.phoneChatAnySession)
        void this.reportSettings()
      })
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

  // ------------------------------------------------------------------ this PC's settings (local UI)

  setKeepAwake(on: boolean) {
    return this.pc.setKeepAwake(on)
  }

  setApprovalMode(mode: ApprovalMode) {
    return this.pc.setApprovalMode(mode)
  }

  /** Remote control can only be switched on here, at the PC. */
  setAllowRemoteControl(on: boolean) {
    if (!on) this.cancelPower()
    return this.pc.setAllowRemoteControl(on)
  }

  setPhoneChatAnySession(on: boolean) {
    return this.pc.setPhoneChatAnySession(on)
  }

  // ------------------------------------------------------------------ developer tools (local UI)

  openLogsFolder() {
    return shell.openPath(join(app.getPath("userData"), "logs")).then(() => undefined)
  }

  /** Copies a non-secret summary for bug reports (no tokens, keys, prompts or file contents). */
  copyDiagnostics() {
    const s = this.state
    const text = [
      `BambooKit Desktop ${app.getVersion()} (${platformName()} ${process.arch}, ${process.getSystemVersion()})`,
      `Electron ${process.versions.electron} · Node ${process.versions.node}`,
      `API ${s.apiUrl} · api=${s.api} realtime=${s.realtime} engine=${s.opencode}`,
      `Device ${s.device ? `${s.device.name} (${s.device.id}, key ${s.device.fingerprint})` : "not registered"}`,
      `Account ${s.account ? `${s.account.provider ?? "email"} sign-in` : "signed out"} · phones ${s.pairedPhones}`,
      `Settings approval=${s.settings.approvalMode} keepAwake=${s.settings.keepAwake} remoteControl=${s.settings.allowRemoteControl} phoneChatAny=${s.settings.phoneChatAnySession}`,
      `Capabilities ${CAPABILITIES.join(", ")}`,
      s.planLimit ? `Plan limit: ${s.planLimit.message}` : null,
      s.error ? `Last error: ${s.error}` : null,
    ]
      .filter(Boolean)
      .join("\n")
    clipboard.writeText(text)
    return text
  }

  /** Drops the realtime connection and registers again (after network changes or a server update). */
  async reconnect() {
    this.disconnect()
    await this.connect()
  }

  /** The user opened a session on this PC: phones may chat in it from now on. */
  sessionOpened(opencodeSessionId: string) {
    this.bridge?.continueOnPc(opencodeSessionId)
  }

  cancelPower() {
    if (this.powerTimer) clearTimeout(this.powerTimer)
    this.powerTimer = null
    if (this.state.pendingPower) log.log("remote power action cancelled at the PC", { action: this.state.pendingPower.action })
    this.update({ pendingPower: null })
  }

  /** Signed-in API calls for the renderer's Profile view (plan, stats, achievements). */
  async apiGet(path: string) {
    if (!/^\/v1\/me(\/(plan|stats|achievements))?$/.test(path)) throw new Error("Not allowed")
    if (!this.api) throw new Error("BambooKit is not ready yet")
    const res = await this.api.request("GET", path)
    return res.data
  }

  // ------------------------------------------------------------------ connection lifecycle

  private registration() {
    return {
      kind: "desktop",
      name: deviceName(),
      platform: platformName(),
      appVersion: app.getVersion(),
      publicKey: this.identity!.publicKeyPem,
      protocol: PROTOCOL,
      capabilities: CAPABILITIES,
      app: { id: "bambookit-desktop", name: "BambooKit Desktop", version: app.getVersion() },
      // Only the settings the API knows; phoneChatAnySession is applied here through each session's remote flag.
      settings: { approvalMode: this.pc.get().approvalMode, keepAwake: this.pc.get().keepAwake, allowRemoteControl: this.pc.get().allowRemoteControl },
    }
  }

  /** Re-registering is an idempotent upsert; it is how a desktop reports changed settings (API 1.3). */
  private async reportSettings() {
    if (!this.api?.deviceId || !this.identity) return
    try {
      await this.api.request("POST", "/v1/devices/register", this.registration(), { signed: true })
    } catch (err: any) {
      log.warn("report settings failed", err?.message)
    }
  }

  private async connect() {
    if (!this.api || !this.identity || !this.auth.current) return
    this.update({ api: "connecting", error: null })
    let attempt = 0
    while (this.auth.current) {
      try {
        const res = await this.api.request("POST", "/v1/devices/register", this.registration(), { signed: true })
        this.api.deviceId = res.data.id
        this.applyDevice(res.data)
        this.update({ api: "connected", planLimit: null })
        break
      } catch (err: any) {
        // The plan's PC limit: say so plainly, and keep checking so an upgrade reconnects without a restart.
        if (err instanceof ApiError && err.status === 402) {
          const details = err.details ?? {}
          this.update({
            api: "error",
            error: err.message,
            planLimit: { message: err.message, max: details.max ?? null, used: details.used ?? null, upgradeUrl: details.upgradeUrl ?? null },
          })
          await sleep(PLAN_LIMIT_RETRY_MS)
          continue
        }
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
    this.bridge = new OpenCodeBridge(
      this.server,
      (batch) => this.publish(batch),
      log,
      (connected) => this.update({ opencode: connected ? "connected" : "connecting" }),
      (sessionId, permission) => this.pc.autoApproves(sessionId, permission),
    )
    this.bridge.setChatAnySession(this.pc.get().phoneChatAnySession)
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
    // Terminal input is never logged (it can contain anything the user types).
    if (command.type !== "TERMINAL_INPUT") log.log("remote command", { id: command.id, type: command.type })
    let report: { status: "SUCCEEDED" | "FAILED"; result?: unknown; error?: string }
    try {
      const pcResult = await this.runPcCommand(command)
      if (pcResult !== undefined) report = { status: "SUCCEEDED", result: pcResult }
      else {
        if (!this.bridge) throw new Error("The BambooKit agent engine is not running")
        report = { status: "SUCCEEDED", result: await this.bridge.execute(command) }
      }
    } catch (err: any) {
      report = { status: "FAILED", error: String(err?.message ?? err).slice(0, 2000) }
    }
    try {
      await this.api!.request("POST", `/v1/commands/${command.id}/result`, report, { signed: true })
    } catch (err: any) {
      if (!(err instanceof ApiError && err.status === 409)) log.warn("report command result failed", err?.message)
    }
  }

  /** Commands about the PC itself. Returns undefined for session commands, which the bridge handles. */
  private async runPcCommand(command: RemoteCommand): Promise<unknown> {
    const p = command.payload ?? {}
    switch (command.type) {
      case "SET_KEEP_AWAKE":
        await this.pc.setKeepAwake(!!p.on)
        return { keepAwake: !!p.on }
      case "SET_APPROVAL_MODE": {
        const mode = p.mode as ApprovalMode | "inherit"
        if (!["ask", "edits", "all", "inherit"].includes(mode)) throw new Error("Unknown approval mode")
        await this.pc.setApprovalMode(mode, p.sessionId ? command.target?.opencodeSessionId : undefined)
        return { approvalMode: mode }
      }
      case "CONTINUE_ON_PC": {
        const target = command.target
        if (!target) throw new Error("Command has no target session")
        this.bridge?.continueOnPc(target.opencodeSessionId)
        // Bring BambooKit forward with the session open, so the person at the PC sees where the chat continues.
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          if (win.isMinimized()) win.restore()
          win.show()
        }
        broadcast("bambookit-event", { type: "open-session", sessionId: target.opencodeSessionId, directory: target.directory })
        return { continued: true }
      }
      case "POWER":
      case "TERMINAL_OPEN":
      case "TERMINAL_INPUT":
      case "TERMINAL_RESIZE":
      case "TERMINAL_CLOSE":
        // The API checks the switch too; the PC enforces it again so a stale or replayed command cannot act.
        if (!this.pc.get().allowRemoteControl) throw new Error("Remote control is turned off on this PC")
        return this.runDeveloperCommand(command.type, p, command.target?.directory)
      default:
        return undefined
    }
  }

  private async runDeveloperCommand(type: string, p: any, directory: string | undefined): Promise<unknown> {
    switch (type) {
      case "POWER": {
        const action: PowerAction = p.action === "shutdown" || p.action === "lock" ? p.action : "sleep"
        this.schedulePower(action)
        return { scheduled: action, countdownSeconds: POWER_COUNTDOWN_SECONDS }
      }
      case "TERMINAL_OPEN": {
        const termId = await openTerminal({ cols: p.cols ?? 80, rows: p.rows ?? 24 }, directory, (id, data) => void this.sendTerminal(id, data))
        return { termId }
      }
      case "TERMINAL_INPUT":
        writeTerminal(String(p.termId), String(p.data ?? ""))
        return { written: true }
      case "TERMINAL_RESIZE":
        resizeTerminal(String(p.termId), Number(p.cols), Number(p.rows))
        return { resized: true }
      case "TERMINAL_CLOSE":
        closeTerminal(String(p.termId))
        return { closed: true }
    }
    return undefined
  }

  private async sendTerminal(termId: string, data: string) {
    if (!this.api?.deviceId) return
    await this.api
      .request("POST", `/v1/devices/${this.api.deviceId}/terminal`, { termId, data: data.slice(0, 500_000) }, { signed: true })
      .catch((err) => log.warn("terminal output failed", err?.message))
  }

  /** Remote power actions run after an on-screen countdown the person at the PC can cancel. */
  private schedulePower(action: PowerAction) {
    this.cancelPower()
    const pending: PendingPower = { id: `power_${Date.now()}`, action, runsAt: Date.now() + POWER_COUNTDOWN_SECONDS * 1000 }
    this.update({ pendingPower: pending })
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      if (win.isMinimized()) win.restore()
      win.show()
    }
    if (Notification.isSupported()) {
      new Notification({ title: "BambooKit", body: `Your phone asked this computer to ${action === "lock" ? "lock" : action === "shutdown" ? "shut down" : "sleep"} in ${POWER_COUNTDOWN_SECONDS} seconds.` }).show()
    }
    this.powerTimer = setTimeout(() => {
      this.powerTimer = null
      this.update({ pendingPower: null })
      log.log("running remote power action", { action })
      runPowerAction(action).catch((err) => log.warn("power action failed", err?.message))
    }, POWER_COUNTDOWN_SECONDS * 1000)
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
    this.cancelPower()
    closeAllTerminals()
    this.pc.dispose()
    this.disconnect()
  }
}

/** The platform name the API, phone and website show ("windows", "mac", "linux"). */
function platformName() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "mac"
  return process.platform
}

function deviceName() {
  if (process.platform === "darwin") {
    // The name from System Settings → General → Sharing (e.g. "Jayash's MacBook Pro"); it already says Mac.
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim()
      if (name) return name.slice(0, 100)
    } catch {}
    const host = hostname().replace(/\.local$/, "")
    return host ? `${host} (Mac)`.slice(0, 100) : "Mac"
  }
  const host = hostname()
  if (process.platform === "linux") return host ? `${host} (Linux)`.slice(0, 100) : "Linux PC"
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
