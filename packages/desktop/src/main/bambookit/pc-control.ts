import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { readState, writeState } from "./secure-store"

/**
 * PC-level controls the phone and website can reach through BambooKit (API 1.3):
 * keep awake, approval modes, and the opt-in developer tools (power actions and a remote terminal).
 *
 * allowRemoteControl can only be switched on from this PC's own UI; remote commands never change it.
 */

export type ApprovalMode = "ask" | "edits" | "all"

export interface PcSettings {
  approvalMode: ApprovalMode
  keepAwake: boolean
  allowRemoteControl: boolean
  /** Phones may chat in any session on this PC, not only sessions continued here. Local setting. */
  phoneChatAnySession: boolean
}

interface StoredSettings extends PcSettings {
  /** Per-session approval mode overrides, keyed by OpenCode session id. */
  sessionModes: Record<string, ApprovalMode>
}

const DEFAULTS: StoredSettings = { approvalMode: "ask", keepAwake: false, allowRemoteControl: false, phoneChatAnySession: true, sessionModes: {} }

/** Permissions OpenCode raises for file changes; "Auto" mode approves only these. */
const EDIT_PERMISSIONS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])

/** Electron's powerSaveBlocker, or a stand-in in tests. */
export interface PowerBlocker {
  start(type: "prevent-display-sleep"): number
  stop(id: number): void
}

async function electronBlocker(): Promise<PowerBlocker> {
  return (await import("electron")).powerSaveBlocker
}

export class PcSettingsStore {
  private settings: StoredSettings = { ...DEFAULTS, sessionModes: {} }
  private blockerId: number | null = null
  private listeners = new Set<(settings: PcSettings) => void>()

  constructor(private readonly blocker: () => Promise<PowerBlocker> = electronBlocker) {}

  async load() {
    const saved = await readState<Partial<StoredSettings>>("pc-settings")
    this.settings = { ...DEFAULTS, ...saved, sessionModes: { ...(saved?.sessionModes ?? {}) } }
    // Keep-awake lasts until it is switched off or the app closes, so it never survives a restart.
    this.settings.keepAwake = false
  }

  get(): PcSettings {
    const { approvalMode, keepAwake, allowRemoteControl, phoneChatAnySession } = this.settings
    return { approvalMode, keepAwake, allowRemoteControl, phoneChatAnySession }
  }

  onChange(cb: (settings: PcSettings) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** The mode that applies to one session: its override, or the PC-wide mode. */
  modeFor(opencodeSessionId: string | undefined): ApprovalMode {
    return (opencodeSessionId && this.settings.sessionModes[opencodeSessionId]) || this.settings.approvalMode
  }

  /** Whether a permission request is approved without asking, under the session's mode. */
  autoApproves(opencodeSessionId: string | undefined, permission: string): boolean {
    const mode = this.modeFor(opencodeSessionId)
    return mode === "all" || (mode === "edits" && EDIT_PERMISSIONS.has(permission))
  }

  async setApprovalMode(mode: ApprovalMode | "inherit", opencodeSessionId?: string) {
    if (opencodeSessionId) {
      if (mode === "inherit") delete this.settings.sessionModes[opencodeSessionId]
      else this.settings.sessionModes[opencodeSessionId] = mode
    } else {
      if (mode === "inherit") throw new Error("'inherit' needs a session")
      this.settings.approvalMode = mode
    }
    await this.save()
  }

  async setKeepAwake(on: boolean) {
    if (on && this.blockerId === null) this.blockerId = (await this.blocker()).start("prevent-display-sleep")
    if (!on && this.blockerId !== null) {
      ;(await this.blocker()).stop(this.blockerId)
      this.blockerId = null
    }
    this.settings.keepAwake = on
    await this.save()
  }

  /** Only called from this PC's own UI (never from a remote command). */
  async setAllowRemoteControl(on: boolean) {
    this.settings.allowRemoteControl = on
    if (!on) closeAllTerminals()
    await this.save()
  }

  async setPhoneChatAnySession(on: boolean) {
    this.settings.phoneChatAnySession = on
    await this.save()
  }

  dispose() {
    const id = this.blockerId
    this.blockerId = null
    if (id !== null) void this.blocker().then((b) => b.stop(id))
  }

  private async save() {
    await writeState("pc-settings", this.settings)
    const snapshot = this.get()
    for (const cb of this.listeners) cb(snapshot)
  }
}

// ------------------------------------------------------------------ power

export type PowerAction = "sleep" | "shutdown" | "lock"

/** Seconds the on-screen countdown gives the person at the PC to cancel a remote power action. */
export const POWER_COUNTDOWN_SECONDS = 10

function powerCommand(action: PowerAction): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      if (action === "sleep") return ["/usr/bin/pmset", ["sleepnow"]]
      // Turning the display off locks the Mac when "Require password after screen saver/sleep" is on (the default).
      if (action === "lock") return ["/usr/bin/pmset", ["displaysleepnow"]]
      return ["/usr/bin/osascript", ["-e", 'tell application "System Events" to shut down']]
    case "win32":
      if (action === "sleep") return ["rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]]
      if (action === "lock") return ["rundll32.exe", ["user32.dll,LockWorkStation"]]
      return ["shutdown.exe", ["/s", "/t", "0"]]
    default:
      if (action === "sleep") return ["systemctl", ["suspend"]]
      if (action === "lock") return ["loginctl", ["lock-session"]]
      return ["systemctl", ["poweroff"]]
  }
}

export function runPowerAction(action: PowerAction): Promise<void> {
  const [command, args] = powerCommand(action)
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (err) => (err ? reject(new Error(`${action} failed: ${err.message}`)) : resolve()))
  })
}

// ------------------------------------------------------------------ terminal

interface Terminal {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const terminals = new Map<string, Terminal>()
const MAX_TERMINALS = 4

function userShell(): [string, string[]] {
  if (process.platform === "win32") return [process.env.COMSPEC || "powershell.exe", []]
  // A login shell, so the phone's terminal has the same PATH (Homebrew, nvm, …) as Terminal.app.
  return [process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"), ["-l"]]
}

/**
 * Opens a shell in a pseudo-terminal. Output is passed to `onData` in small batches; nothing is logged or stored.
 */
export async function openTerminal(
  size: { cols: number; rows: number },
  cwd: string | undefined,
  onData: (termId: string, data: string) => void,
): Promise<string> {
  if (terminals.size >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} remote terminals can be open at once`)
  const pty = await import("@lydell/node-pty")
  const [shell, args] = userShell()
  const termId = `term_${randomUUID()}`
  const child = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: cwd || homedir(),
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  })

  // Coalesce output so a fast command does not turn into thousands of requests.
  let buffer = ""
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    if (!buffer) return
    const chunk = buffer
    buffer = ""
    onData(termId, chunk)
  }
  child.onData((data) => {
    buffer += data
    if (buffer.length > 200_000) flush()
    else if (!timer) timer = setTimeout(flush, 50)
  })
  child.onExit(({ exitCode }) => {
    flush()
    onData(termId, `\r\n[process exited with code ${exitCode}]\r\n`)
    terminals.delete(termId)
  })

  terminals.set(termId, {
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => child.kill(),
  })
  return termId
}

function terminal(termId: string) {
  const t = terminals.get(termId)
  if (!t) throw new Error("That terminal is closed")
  return t
}

export function writeTerminal(termId: string, data: string) {
  terminal(termId).write(data)
}

export function resizeTerminal(termId: string, cols: number, rows: number) {
  terminal(termId).resize(cols, rows)
}

export function closeTerminal(termId: string) {
  terminals.get(termId)?.kill()
  terminals.delete(termId)
}

export function closeAllTerminals() {
  for (const id of [...terminals.keys()]) closeTerminal(id)
}
