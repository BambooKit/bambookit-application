import { createHash } from "node:crypto"
import { projectDiagram, sessionFileMap } from "./project-map"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { backoff, readSse } from "./sse"
import { SessionStatsTracker, type SessionStats } from "./session-stats"
import { readState, writeState } from "./secure-store"

/**
 * Bridge between the local OpenCode server (loopback sidecar) and BambooKit.
 *
 * - Subscribes to OpenCode's /global/event stream and converts it into compact sync batches
 *   (projects, sessions, transcript parts, diff summaries, permission requests).
 * - Executes authorized remote commands by calling OpenCode's own HTTP API, so OpenCode's
 *   permission model, tools and agents stay in charge. Nothing here runs shell commands.
 * - Applies the PC's approval mode: requests the mode allows are answered "once" automatically, after they have
 *   been recorded, so auto-approved requests still appear in the phone's history.
 */

export interface SyncBatch {
  projects?: Array<{ opencodeProjectId: string; name: string; directory: string; branch?: string | null }>
  sessions?: Array<SessionSync>
  removedSessions?: string[]
  parts?: Array<PartSync>
  /** Sessions whose transcript changed as a whole (rewind, deletions): clients refetch it from this PC. */
  transcriptsChanged?: string[]
  diffs?: Array<{ opencodeSessionId: string; files: Array<{ file: string; status?: string | null; additions: number; deletions: number }> }>
  approvals?: Array<ApprovalSync>
  pendingApprovalSnapshot?: string[]
  activity?: Array<{ opencodeSessionId?: string | null; type: string; summary: string; data?: Record<string, unknown> }>
}

interface SessionSync {
  opencodeSessionId: string
  opencodeProjectId?: string | null
  parentId?: string | null
  directory: string
  title: string
  status: "idle" | "busy" | "retry" | "error"
  statusMessage?: string | null
  agent?: string | null
  model?: string | null
  additions: number
  deletions: number
  files: number
  currentAction?: string | null
  /** Continued on this PC while BambooKit was running: only then may phones chat in it. */
  remote: boolean
  createdAt?: string
  /** Work statistics for the Profile and achievements (capability session-stats). */
  stats?: SessionStats
}

interface PartSync {
  opencodeSessionId: string
  messageId: string
  partId: string
  role: "user" | "assistant"
  type: "text" | "reasoning" | "tool"
  text?: string | null
  tool?: string | null
  toolStatus?: string | null
  toolTitle?: string | null
  sortKey: string
}

interface ApprovalSync {
  opencodeSessionId: string
  requestId: string
  permission: string
  title?: string | null
  patterns: string[]
  status: "PENDING" | "APPROVED" | "REJECTED"
  reply?: string | null
}

export interface RemoteCommand {
  id: string
  type: string
  payload: any
  target: { opencodeSessionId: string; directory: string } | null
}

interface SessionState extends SessionSync {
  lastModel?: { providerID: string; modelID: string }
  lastAgent?: string
  /** Messages from this id onward are rewound (hidden) until the next prompt. */
  revertMessageId?: string | null
  shareUrl?: string | null
}

/** A file change derived from the agent's own write/edit/patch tool calls. */
interface DerivedChange {
  file: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
  patches: string[]
}

interface MessageMeta {
  sessionId: string
  role: "user" | "assistant"
  created: number
}

type Logger = { log: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void }

/** Decides whether a permission request is approved without asking (the PC's approval mode). */
export type ApprovalPolicy = (opencodeSessionId: string, permission: string) => boolean

const MAX_TEXT = 20_000

export class OpenCodeBridge {
  private abort: AbortController | null = null
  private running = false
  private sessions = new Map<string, SessionState>()
  private projects = new Map<string, { opencodeProjectId: string; name: string; directory: string; branch?: string | null }>()
  private projectByDirectory = new Map<string, string>()
  private messages = new Map<string, MessageMeta>()
  private textBuffers = new Map<string, { part: PartSync; text: string }>()
  private pendingApprovals = new Map<string, ApprovalSync & { directory: string }>()
  /** Per session: changes derived from tool calls, and the engine's snapshot diff (empty when snapshots are off). */
  private derived = new Map<string, Map<string, DerivedChange>>()
  private engineDiff = new Map<string, Array<{ file: string; status: string | null; additions: number; deletions: number }>>()
  private seenToolParts = new Set<string>()
  private transcriptTimers = new Map<string, NodeJS.Timeout>()
  private reshared = new Set<string>()
  /** Sessions the user continued on this PC in this run (see SessionSync.remote). */
  private continuedOnPc = new Set<string>()
  /** When this bridge last sent a prompt on a phone's behalf, per session. */
  private remoteSentAt = new Map<string, number>()
  private lastUserText = new Map<string, string>()
  private stats = new SessionStatsTracker()
  private statsLoaded: Promise<void> | null = null
  /** When on, phones may chat in every session on this PC, not only the ones continued here. */
  private chatAnySession = false
  private outbox: SyncBatch = {}
  private flushTimer: NodeJS.Timeout | null = null
  private connected = false

  constructor(
    private readonly server: { url: string; username: string; password: string },
    private readonly publish: (batch: SyncBatch) => Promise<void>,
    private readonly log: Logger,
    private readonly onStatus: (connected: boolean) => void = () => {},
    private readonly autoApproves: ApprovalPolicy = () => false,
  ) {}

  get isConnected() {
    return this.connected
  }

  start() {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop() {
    this.running = false
    this.abort?.abort()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /** Re-send the full current state (used after the API connection is re-established). */
  async resync(): Promise<void> {
    await this.snapshot()
  }

  // ------------------------------------------------------------------ OpenCode HTTP

  private async oc<T = any>(method: string, path: string, query: Record<string, string | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(path, this.server.url)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v)
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.server.username}:${this.server.password}`).toString("base64")}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Engine ${method} ${url.pathname} → ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  private async loop() {
    // Saved counters must be in place before new events add to them.
    this.statsLoaded ??= Promise.all([
      this.stats.load(),
      // Sessions continued on this PC stay continued across restarts and updates.
      readState<string[]>("continued-sessions").then((ids) => {
        for (const id of ids ?? []) this.continuedOnPc.add(id)
      }),
    ])
      .then(() => undefined)
      .catch((err) => this.log.warn("bambookit: saved state load failed", String(err)))
    await this.statsLoaded
    let attempt = 0
    while (this.running) {
      this.abort = new AbortController()
      try {
        const opened = readSse(
          new URL("/global/event", this.server.url).toString(),
          {
            signal: this.abort.signal,
            headers: { Authorization: `Basic ${Buffer.from(`${this.server.username}:${this.server.password}`).toString("base64")}` },
          },
          (msg) => {
            if (!this.connected) {
              this.connected = true
              this.onStatus(true)
              attempt = 0
              void this.snapshot().catch((err) => this.log.warn("bambookit snapshot failed", String(err)))
            }
            try {
              this.handle(JSON.parse(msg.data))
            } catch (err) {
              this.log.warn("bambookit: bad opencode event", String(err))
            }
          },
        )
        await opened
      } catch (err: any) {
        if (!this.running) break
        this.log.warn("bambookit: opencode event stream error", err?.message ?? String(err))
      }
      if (this.connected) {
        this.connected = false
        this.onStatus(false)
      }
      if (!this.running) break
      await sleep(backoff(attempt++, 500, 10_000))
    }
  }

  // ------------------------------------------------------------------ snapshot

  private async snapshot() {
    const projects = await this.oc<any[]>("GET", "/project")
    const batch: SyncBatch = { projects: [], sessions: [], approvals: [], diffs: [], parts: [], pendingApprovalSnapshot: [] }
    const recent: SessionState[] = []

    for (const p of projects ?? []) {
      if (!p?.worktree || p.worktree === "/") continue
      const project = { opencodeProjectId: p.id, name: p.name || basename(p.worktree) || p.worktree, directory: p.worktree, branch: null as string | null }
      try {
        const vcs = await this.oc<any>("GET", "/vcs", { directory: p.worktree })
        project.branch = vcs?.branch ?? null
      } catch {}
      this.projects.set(p.id, project)
      this.projectByDirectory.set(p.worktree, p.id)
      batch.projects!.push(project)

      const [sessions, status, permissions] = await Promise.all([
        this.oc<any[]>("GET", "/session", { directory: p.worktree, limit: "50" }).catch(() => []),
        this.oc<Record<string, any>>("GET", "/session/status", { directory: p.worktree }).catch(() => ({})),
        this.oc<any[]>("GET", "/permission", { directory: p.worktree }).catch(() => []),
      ])

      for (const s of sessions ?? []) {
        const state = this.upsertSessionInfo(s)
        const st = (status as Record<string, any> | null)?.[s.id]
        if (st) this.applyStatus(state, st)
        batch.sessions!.push(this.sessionSync(state))
        if (!s.parentID) recent.push(state)
        // Sessions published before BambooKit hosted sharing keep a third-party link; publish them again here.
        if (typeof s.share?.url === "string" && /opncd\.ai|opencode\.ai/.test(s.share.url) && !this.reshared.has(s.id)) {
          this.reshared.add(s.id)
          void this.oc("POST", `/session/${s.id}/share`, { directory: s.directory }).catch((err) => this.log.warn("bambookit re-share failed", String(err)))
        }
      }
      for (const perm of permissions ?? []) {
        const a = this.permissionToApproval(perm, p.worktree)
        batch.approvals!.push(a)
        batch.pendingApprovalSnapshot!.push(a.requestId)
        this.maybeAutoApprove(a)
      }
    }

    // Only the session index goes to the API; chats are read live from this PC on request (answerRelay).
    await this.publish(batch)
  }

  /** A session's visible transcript and file changes, read from the local engine. */
  private async loadTranscript(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("This session is not on this PC")
    const [messages, diff] = await Promise.all([
      this.oc<any[]>("GET", `/session/${sessionId}/message`, { directory: session.directory, limit: "200" }),
      this.oc<any[]>("GET", `/session/${sessionId}/diff`, { directory: session.directory }).catch(() => null),
    ])
    const parts: PartSync[] = []
    this.derived.delete(sessionId)
    for (const m of messages ?? []) {
      this.trackMessage(m.info)
      // Rewound messages are hidden until the next prompt removes them for good.
      if (session.revertMessageId && String(m.info?.id) >= session.revertMessageId) continue
      for (const part of m.parts ?? []) {
        this.trackChange(part, session.directory)
        const p = this.partSync(part)
        if (p) parts.push(p)
      }
    }
    if (diff) this.engineDiff.set(sessionId, diffFiles(diff))
    return { parts: parts.slice(-2000), files: this.changesFor(sessionId), messages: messages ?? [], directory: session.directory }
  }

  /** Answers a live request from the phone or website, relayed by the API. Nothing is stored there. */
  async answerRelay(kind: string, params: { opencodeSessionId?: string; path?: string }) {
    const id = String(params?.opencodeSessionId ?? "")
    if (kind === "transcript") return { parts: (await this.loadTranscript(id)).parts }
    if (kind === "changes") return { files: (await this.loadTranscript(id)).files }
    if (kind === "filemap") {
      const t = await this.loadTranscript(id)
      return { files: sessionFileMap(t.messages, t.directory, t.files) }
    }
    if (kind === "tree") return await this.listFolder(id, String(params?.path ?? ""))
    if (kind === "file") return await this.readProjectFile(id, String(params?.path ?? ""))
    if (kind === "diagram") {
      const session = this.sessions.get(id)
      if (!session) throw new Error("This session is not on this PC")
      return await projectDiagram(session.directory)
    }
    throw new Error(`Unsupported request ${kind}`)
  }

  /** One folder of the session's project for the phone/website file browser (view only). */
  private async listFolder(sessionId: string, path: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("This session is not on this PC")
    const root = await realpath(session.directory)
    const wanted = path.trim().replace(/^[\/]+|[\/]+$/g, "")
    const dir = wanted && wanted !== "." ? await resolveInside(session.directory, wanted, true) : root
    if (!(await stat(dir)).isDirectory()) throw new Error("Not a folder")
    const items = await readdir(dir, { withFileTypes: true })
    const entries: Array<{ name: string; path: string; type: "directory" | "file"; size: number | null }> = []
    for (const e of items) {
      if (e.name === ".git" || (!e.isDirectory() && !e.isFile())) continue
      const abs = join(dir, e.name)
      const size = e.isFile() ? ((await stat(abs).catch(() => null))?.size ?? null) : null
      entries.push({ name: e.name, path: displayPath(root, abs), type: e.isDirectory() ? "directory" : "file", size })
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
    return { path: dir === root ? "" : displayPath(root, dir), entries: entries.slice(0, 2000), truncated: entries.length > 2000 }
  }

  /** A project file's text for the phone/website code viewer (view only, up to 1 MB). */
  private async readProjectFile(sessionId: string, path: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("This session is not on this PC")
    const file = await resolveInside(session.directory, path, true)
    const info = await stat(file)
    if (!info.isFile()) throw new Error("Not a file")
    if (info.size > 1_000_000) throw new Error("This file is larger than 1 MB; open it on your PC")
    const buf = await readFile(file)
    if (buf.subarray(0, 8000).includes(0)) throw new Error("Binary files cannot be shown")
    return { path: displayPath(await realpath(session.directory), file), content: buf.toString("utf8"), size: info.size }
  }

  private markContinued(sessionId: string) {
    if (this.continuedOnPc.has(sessionId)) return
    this.continuedOnPc.add(sessionId)
    // Keep the saved list bounded (oldest first out).
    if (this.continuedOnPc.size > 2000) this.continuedOnPc.delete(this.continuedOnPc.values().next().value!)
    void writeState("continued-sessions", [...this.continuedOnPc]).catch(() => undefined)
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.remote = true
    this.queueSession(state)
  }

  /** The session was opened on this PC or a phone asked to continue it here: phones may now chat in it. */
  continueOnPc(sessionId: string) {
    this.markContinued(sessionId)
  }

  /** "Let my phone chat in any session": every session on this PC is open to the owner's phone. */
  setChatAnySession(on: boolean) {
    if (this.chatAnySession === on) return
    this.chatAnySession = on
    for (const state of this.sessions.values()) {
      state.remote = this.isRemote(state.opencodeSessionId)
      this.queueSession(state)
    }
  }

  private isRemote(sessionId: string) {
    return this.chatAnySession || this.continuedOnPc.has(sessionId)
  }

  private requireContinued(sessionId: string) {
    if (!this.isRemote(sessionId)) throw new Error("Continue this session on your PC first, then you can chat in it from your phone.")
  }

  /** Debounced full transcript resync (after rewinds or removed messages). */
  private scheduleTranscript(sessionId: string) {
    const t = this.transcriptTimers.get(sessionId)
    if (t) clearTimeout(t)
    this.transcriptTimers.set(
      sessionId,
      setTimeout(() => {
        this.transcriptTimers.delete(sessionId)
        this.queue({ transcriptsChanged: [sessionId] })
      }, 800),
    )
  }

  /** Engine snapshot diff when it has one; otherwise the changes derived from the agent's tool calls. */
  private changesFor(sessionId: string) {
    const engine = this.engineDiff.get(sessionId) ?? []
    if (engine.length) return engine
    return [...(this.derived.get(sessionId)?.values() ?? [])].map(({ patches: _p, ...c }) => c)
  }

  /** Records file changes from completed write/edit/patch tool calls. Returns true when something changed. */
  private trackChange(part: any, directory: string): boolean {
    if (part?.type !== "tool" || part.state?.status !== "completed") return false
    const key = `${part.sessionID}:${part.id}`
    if (this.seenToolParts.has(key)) return false
    const changes = toolChanges(part, directory)
    if (!changes.length) return false
    this.seenToolParts.add(key)
    if (this.seenToolParts.size > 20000) this.seenToolParts.clear()
    const map = this.derived.get(part.sessionID) ?? new Map<string, DerivedChange>()
    for (const c of changes) {
      const prev = map.get(c.file)
      map.set(c.file, prev
        ? { file: c.file, status: prev.status === "added" && c.status !== "deleted" ? "added" : c.status, additions: prev.additions + c.additions, deletions: prev.deletions + c.deletions, patches: [...prev.patches, ...c.patches].slice(-20) }
        : c)
    }
    this.derived.set(part.sessionID, map)
    return true
  }

  // ------------------------------------------------------------------ live events

  private handle(event: { directory?: string; payload?: { type: string; properties: any } }) {
    const payload = event.payload
    if (!payload) return
    const p = payload.properties ?? {}
    switch (payload.type) {
      case "session.created":
      case "session.updated": {
        const before = this.sessions.get(p.info?.id)?.revertMessageId ?? null
        const state = this.upsertSessionInfo(p.info)
        this.queueSession(state)
        if (p.info?.summary?.diffs) {
          this.engineDiff.set(state.opencodeSessionId, diffFiles(p.info.summary.diffs))
          this.queue({ diffs: [{ opencodeSessionId: state.opencodeSessionId, files: this.changesFor(state.opencodeSessionId) }] })
        }
        // A rewind (or undoing one) changes which messages are visible.
        if ((state.revertMessageId ?? null) !== before) this.scheduleTranscript(state.opencodeSessionId)
        break
      }
      case "session.deleted":
        this.sessions.delete(p.sessionID)
        this.stats.forget(p.sessionID)
        this.queue({ removedSessions: [p.sessionID] })
        break
      case "session.status": {
        const state = this.sessions.get(p.sessionID)
        if (!state) return
        this.applyStatus(state, p.status)
        this.queueSession(state)
        break
      }
      case "session.idle": {
        const state = this.sessions.get(p.sessionID)
        if (!state) return
        if (state.status !== "error") state.status = "idle"
        state.currentAction = null
        this.queueSession(state)
        break
      }
      case "session.error": {
        const state = p.sessionID ? this.sessions.get(p.sessionID) : undefined
        const name = p.error?.name ?? "Error"
        const message = String(p.error?.data?.message ?? p.error?.message ?? name).slice(0, 500)
        if (name === "MessageAbortedError") {
          this.queue({ activity: [{ opencodeSessionId: p.sessionID, type: "session.aborted", summary: "Session stopped" }] })
          break
        }
        if (state) {
          state.status = "error"
          state.statusMessage = message
          state.currentAction = null
          this.queueSession(state)
        }
        this.queue({ activity: [{ opencodeSessionId: p.sessionID, type: "session.error", summary: message, data: { name } }] })
        break
      }
      case "session.diff":
        this.engineDiff.set(p.sessionID, diffFiles(p.diff))
        this.queue({ diffs: [{ opencodeSessionId: p.sessionID, files: this.changesFor(p.sessionID) }] })
        break
      case "message.removed":
      case "message.part.removed":
        if (p.sessionID) this.scheduleTranscript(p.sessionID)
        break
      case "message.updated": {
        const state = this.sessions.get(p.sessionID)
        // A new prompt typed on this PC (not one this bridge sent for a phone) continues the session here.
        const fresh = p.info?.id && !this.messages.has(p.info.id) && Date.now() - (p.info.time?.created ?? 0) < 60_000
        if (state && fresh && p.info.role === "user" && Date.now() - (this.remoteSentAt.get(p.sessionID) ?? 0) > 30_000) {
          this.markContinued(p.sessionID)
        }
        this.trackMessage(p.info)
        if (state && p.info?.role === "assistant") {
          if (p.info.providerID && p.info.modelID) {
            state.model = `${p.info.providerID}/${p.info.modelID}`
            state.lastModel = { providerID: p.info.providerID, modelID: p.info.modelID }
          }
          if (p.info.agent || p.info.mode) state.agent = state.lastAgent = p.info.agent ?? p.info.mode
          this.queueSession(state)
        }
        break
      }
      case "message.part.updated": {
        const part = this.partSync(p.part)
        if (!part) return
        this.textBuffers.delete(part.partId)
        const state = this.sessions.get(part.opencodeSessionId)
        if (state && this.trackChange(p.part, state.directory)) {
          this.queue({ diffs: [{ opencodeSessionId: part.opencodeSessionId, files: this.changesFor(part.opencodeSessionId) }] })
        }
        if (state && part.type === "tool") {
          state.currentAction = part.toolStatus === "running" || part.toolStatus === "pending" ? describeAction(part) : state.currentAction
          if (part.toolStatus === "completed" || part.toolStatus === "error") {
            const changes = part.toolStatus === "completed" ? toolChanges(p.part, state.directory) : []
            this.stats.onToolFinished(part.opencodeSessionId, p.part, changes)
          }
          this.queueSession(state)
        }
        if (state && part.type === "text" && part.role === "user" && part.text) {
          if (this.stats.onPrompt(part.opencodeSessionId, part.messageId, part.text)) this.queueSession(state)
        }
        this.queue({ parts: [part] })
        break
      }
      case "message.part.delta": {
        if (p.field !== "text") return
        const meta = this.messages.get(p.messageID)
        const existing = this.textBuffers.get(p.partID)
        const text = (existing?.text ?? "") + p.delta
        const part: PartSync = existing?.part ?? {
          opencodeSessionId: p.sessionID,
          messageId: p.messageID,
          partId: p.partID,
          role: meta?.role ?? "assistant",
          type: "text",
          sortKey: sortKey(meta?.created ?? Date.now(), p.partID),
        }
        this.textBuffers.set(p.partID, { part, text })
        const state = this.sessions.get(p.sessionID)
        if (state && state.currentAction !== "Writing response") {
          state.currentAction = "Writing response"
          this.queueSession(state)
        }
        this.queue({ parts: [{ ...part, text: text.slice(0, MAX_TEXT) }] })
        break
      }
      case "permission.asked": {
        const directory = this.sessions.get(p.sessionID)?.directory ?? event.directory ?? ""
        const approval = this.permissionToApproval(p, directory)
        const state = this.sessions.get(p.sessionID)
        if (state) {
          state.currentAction = `Waiting for approval: ${approval.title ?? approval.permission}`
          this.queueSession(state)
        }
        this.queue({ approvals: [approval] })
        this.maybeAutoApprove(approval)
        break
      }
      case "permission.replied": {
        const pending = this.pendingApprovals.get(p.requestID)
        this.pendingApprovals.delete(p.requestID)
        if (!pending) return
        this.queue({ approvals: [{ ...stripDirectory(pending), status: p.reply === "reject" ? "REJECTED" : "APPROVED", reply: p.reply }] })
        break
      }
      case "file.edited":
        this.queue({ activity: [{ type: "file.edited", summary: String(p.file).slice(0, 500) }] })
        break
      case "vcs.branch.updated": {
        const projectId = event.directory ? this.projectByDirectory.get(event.directory) : undefined
        const project = projectId ? this.projects.get(projectId) : undefined
        if (project) {
          project.branch = p.branch ?? null
          this.queue({ projects: [project] })
        }
        break
      }
      case "project.updated": {
        const info = p.info ?? p
        if (info?.id && info?.worktree) {
          const project = { opencodeProjectId: info.id, name: info.name || basename(info.worktree), directory: info.worktree, branch: this.projects.get(info.id)?.branch ?? null }
          this.projects.set(info.id, project)
          this.projectByDirectory.set(info.worktree, info.id)
          this.queue({ projects: [project] })
        }
        break
      }
    }
  }

  // ------------------------------------------------------------------ mapping helpers

  private upsertSessionInfo(info: any): SessionState {
    const existing = this.sessions.get(info.id)
    const state: SessionState = {
      opencodeSessionId: info.id,
      opencodeProjectId: info.projectID ?? null,
      parentId: info.parentID ?? null,
      directory: info.directory,
      title: info.title || "New session",
      status: existing?.status ?? "idle",
      statusMessage: existing?.statusMessage ?? null,
      agent: info.agent ?? existing?.agent ?? null,
      model: existing?.model ?? (info.model?.providerID && (info.model?.id || info.model?.modelID) ? `${info.model.providerID}/${info.model.id ?? info.model.modelID}` : null),
      additions: info.summary?.additions ?? existing?.additions ?? 0,
      deletions: info.summary?.deletions ?? existing?.deletions ?? 0,
      files: info.summary?.files ?? existing?.files ?? 0,
      currentAction: existing?.currentAction ?? null,
      remote: this.isRemote(info.id),
      createdAt: info.time?.created ? new Date(info.time.created).toISOString() : existing?.createdAt,
      lastModel: existing?.lastModel,
      lastAgent: existing?.lastAgent,
      revertMessageId: info.revert?.messageID ?? null,
      shareUrl: info.share?.url ?? existing?.shareUrl ?? null,
    }
    if (!state.opencodeProjectId && state.directory) state.opencodeProjectId = this.projectByDirectory.get(state.directory) ?? null
    this.sessions.set(info.id, state)
    return state
  }

  private applyStatus(state: SessionState, status: any) {
    if (status?.type === "busy") {
      state.status = "busy"
      state.statusMessage = null
    } else if (status?.type === "retry") {
      state.status = "retry"
      state.statusMessage = String(status.message ?? "Retrying").slice(0, 500)
    } else if (status?.type === "idle") {
      if (state.status !== "error") state.status = "idle"
      state.currentAction = null
    }
  }

  private sessionSync(s: SessionState): SessionSync {
    const { lastModel: _m, lastAgent: _a, revertMessageId: _r, shareUrl: _s, ...sync } = s
    const stats = this.stats.get(s.opencodeSessionId)
    return stats ? { ...sync, stats } : sync
  }

  private trackMessage(info: any) {
    if (!info?.id) return
    this.messages.set(info.id, { sessionId: info.sessionID, role: info.role, created: info.time?.created ?? Date.now() })
    const state = this.sessions.get(info.sessionID)
    if (state && info.role === "user") {
      if (info.model?.providerID && info.model?.modelID) state.lastModel = { providerID: info.model.providerID, modelID: info.model.modelID }
      if (info.agent) state.lastAgent = info.agent
    }
    if (this.messages.size > 5000) this.messages.delete(this.messages.keys().next().value!)
  }

  private partSync(part: any): PartSync | null {
    if (!part?.id || !part.sessionID) return null
    const meta = this.messages.get(part.messageID)
    const base = {
      opencodeSessionId: part.sessionID,
      messageId: part.messageID,
      partId: part.id,
      role: meta?.role ?? "assistant",
      sortKey: sortKey(meta?.created ?? part.time?.start ?? Date.now(), part.id),
    } as const
    if (part.type === "text") {
      if (part.synthetic || part.ignored) return null
      if (base.role === "user") this.lastUserText.set(part.sessionID, part.text)
      return { ...base, type: "text", text: String(part.text ?? "").slice(0, MAX_TEXT) }
    }
    if (part.type === "reasoning") return { ...base, type: "reasoning", text: String(part.text ?? "").slice(0, 4000) }
    if (part.type === "tool") {
      const state = part.state ?? {}
      return {
        ...base,
        type: "tool",
        tool: part.tool,
        toolStatus: state.status ?? null,
        toolTitle: String(state.title || describeInput(part.tool, state.input) || part.tool).slice(0, 500),
        text: state.status === "error" ? String(state.error ?? "").slice(0, 1000) : null,
      }
    }
    return null
  }

  private permissionToApproval(p: any, directory: string): ApprovalSync & { directory: string } {
    const meta = p.metadata ?? {}
    const title = meta.command ?? meta.filepath ?? meta.filePath ?? meta.url ?? meta.title ?? (p.patterns?.length ? p.patterns.join(" ") : null)
    const approval = {
      opencodeSessionId: p.sessionID,
      requestId: p.id,
      permission: p.permission,
      title: title ? String(title).slice(0, 1000) : null,
      patterns: (p.patterns ?? []).map((x: unknown) => String(x).slice(0, 1000)).slice(0, 50),
      status: "PENDING" as const,
      directory,
    }
    this.pendingApprovals.set(p.id, approval)
    return approval
  }

  /** Answers a request "once" when the approval mode allows it; the reply event then records it as approved. */
  private maybeAutoApprove(approval: ApprovalSync & { directory: string }) {
    if (!this.autoApproves(approval.opencodeSessionId, approval.permission)) return
    void this.oc("POST", `/permission/${approval.requestId}/reply`, { directory: approval.directory }, { reply: "once" })
      .then(() => this.queue({ activity: [{ opencodeSessionId: approval.opencodeSessionId, type: "approval.auto", summary: `Auto-approved: ${approval.title ?? approval.permission}`.slice(0, 500) }] }))
      .catch((err) => this.log.warn("bambookit auto-approve failed", String(err)))
  }

  /** Approves requests that are waiting when the approval mode is relaxed (e.g. switched to Auto-approve). */
  applyApprovalMode() {
    for (const approval of [...this.pendingApprovals.values()]) this.maybeAutoApprove(approval)
  }

  // ------------------------------------------------------------------ outbox

  private queueSession(state: SessionState) {
    this.queue({ sessions: [this.sessionSync(state)] })
  }

  private queue(batch: SyncBatch) {
    const out = this.outbox as Record<string, any[]>
    for (const [key, value] of Object.entries(batch)) {
      if (!Array.isArray(value)) continue
      out[key] = [...(out[key] ?? []), ...value]
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 400)
  }

  private async flush() {
    this.flushTimer = null
    const batch = this.outbox
    this.outbox = {}
    // Keep only the latest version of each session/part within the batch.
    if (batch.sessions) batch.sessions = latestBy(batch.sessions, (s) => s.opencodeSessionId)
    if (batch.parts) batch.parts = latestBy(batch.parts, (p) => p.partId)
    if (batch.projects) batch.projects = latestBy(batch.projects, (p) => p.opencodeProjectId)
    if (batch.diffs) batch.diffs = latestBy(batch.diffs, (d) => d.opencodeSessionId)
    if (batch.transcriptsChanged) batch.transcriptsChanged = [...new Set(batch.transcriptsChanged)]
    if (batch.approvals) batch.approvals = latestBy(batch.approvals.map(stripDirectory), (a) => a.requestId)
    try {
      await this.publish(batch)
    } catch (err) {
      // State is re-sent in full on reconnect (resync), so a dropped batch is not lost permanently.
      this.log.warn("bambookit: sync batch failed", String(err))
    }
  }

  // ------------------------------------------------------------------ commands

  async execute(command: RemoteCommand): Promise<unknown> {
    const target = command.target
    const session = target ? this.sessions.get(target.opencodeSessionId) : undefined
    const directory = target?.directory

    const promptBody = (text: string) => ({
      parts: [{ type: "text", text }],
      ...(session?.lastModel ? { model: session.lastModel } : {}),
      ...(session?.lastAgent ? { agent: session.lastAgent } : {}),
    })

    if (target && ["SEND_MESSAGE", "CONTINUE", "RETRY", "REVERT", "UNREVERT"].includes(command.type)) {
      this.requireContinued(target.opencodeSessionId)
      this.remoteSentAt.set(target.opencodeSessionId, Date.now())
    }

    switch (command.type) {
      case "SEND_MESSAGE":
        requireTarget(target)
        await this.oc("POST", `/session/${target!.opencodeSessionId}/prompt_async`, { directory }, promptBody(command.payload.text))
        return { sent: true }
      case "CONTINUE":
        requireTarget(target)
        await this.oc("POST", `/session/${target!.opencodeSessionId}/prompt_async`, { directory }, promptBody("Continue."))
        return { sent: true, text: "Continue." }
      case "RETRY": {
        requireTarget(target)
        let text = this.lastUserText.get(target!.opencodeSessionId)
        if (!text) {
          const messages = await this.oc<any[]>("GET", `/session/${target!.opencodeSessionId}/message`, { directory, limit: "50" })
          for (const m of messages ?? []) {
            if (m.info?.role !== "user") continue
            const t = (m.parts ?? []).find((x: any) => x.type === "text" && !x.synthetic)?.text
            if (t) text = t
          }
        }
        if (!text) throw new Error("No previous user message to retry")
        await this.oc("POST", `/session/${target!.opencodeSessionId}/prompt_async`, { directory }, promptBody(text))
        return { sent: true, text }
      }
      case "ABORT":
        requireTarget(target)
        await this.oc("POST", `/session/${target!.opencodeSessionId}/abort`, { directory })
        return { aborted: true }
      case "PERMISSION_REPLY": {
        const pending = this.pendingApprovals.get(command.payload.requestId)
        await this.oc("POST", `/permission/${command.payload.requestId}/reply`, { directory: pending?.directory ?? directory }, { reply: command.payload.reply })
        return { replied: command.payload.reply }
      }
      case "GET_DIFF": {
        requireTarget(target)
        const engine = await this.oc<any[]>("GET", `/session/${target!.opencodeSessionId}/diff`, { directory }).catch(() => [])
        const derivedFiles = [...(this.derived.get(target!.opencodeSessionId)?.values() ?? [])].map((c) => ({
          file: c.file, status: c.status, additions: c.additions, deletions: c.deletions, patch: c.patches.join("\n"),
        }))
        const diff = engine?.length ? engine : derivedFiles
        const wanted = command.payload?.file
        let budget = 400_000
        const files = (diff ?? [])
          .filter((d) => !wanted || d.file === wanted)
          .map((d) => {
            const patch = typeof d.patch === "string" ? d.patch : ""
            const take = Math.max(0, Math.min(patch.length, budget))
            budget -= take
            return { file: d.file, status: d.status ?? null, additions: d.additions ?? 0, deletions: d.deletions ?? 0, patch: patch.slice(0, take), truncated: take < patch.length }
          })
        return { files }
      }
      case "REFRESH":
        if (target) this.queue({ transcriptsChanged: [target.opencodeSessionId] })
        else await this.snapshot()
        return { refreshed: true }
      case "REVERT": {
        requireTarget(target)
        await this.oc("POST", `/session/${target!.opencodeSessionId}/revert`, { directory }, { messageID: command.payload.messageId })
        this.scheduleTranscript(target!.opencodeSessionId)
        return { reverted: command.payload.messageId }
      }
      case "UNREVERT":
        requireTarget(target)
        await this.oc("POST", `/session/${target!.opencodeSessionId}/unrevert`, { directory })
        this.scheduleTranscript(target!.opencodeSessionId)
        return { unreverted: true }
      case "SHARE": {
        requireTarget(target)
        const info = await this.oc<any>("POST", `/session/${target!.opencodeSessionId}/share`, { directory })
        return { url: info?.share?.url ?? null }
      }
      case "UNSHARE":
        requireTarget(target)
        await this.oc("DELETE", `/session/${target!.opencodeSessionId}/share`, { directory })
        return { unshared: true }
      case "READ_FILE": {
        requireTarget(target)
        const file = await resolveInside(directory!, command.payload.path, true)
        const info = await stat(file)
        if (!info.isFile()) throw new Error("Not a file")
        if (info.size > 1_000_000) throw new Error("File is larger than 1 MB")
        const buf = await readFile(file)
        if (buf.subarray(0, 8000).includes(0)) throw new Error("Binary files cannot be shown")
        return { path: displayPath(directory!, file), content: buf.toString("utf8"), sha256: sha256(buf), size: info.size }
      }
      case "WRITE_FILE":
        throw new Error("Files are view-only from the phone. Edit them in BambooKit Desktop.")
      case "CREATE_SESSION":
        throw new Error("Start new sessions in BambooKit Desktop on your PC.")
      default:
        throw new Error(`Unsupported command ${command.type}`)
    }
  }
}

// ------------------------------------------------------------------ utilities

function requireTarget(target: RemoteCommand["target"]) {
  if (!target) throw new Error("Command has no target session")
}

function sortKey(created: number, partId: string) {
  return `${String(Math.floor(created)).padStart(15, "0")}:${partId}`
}

function diffFiles(diff: any[]): Array<{ file: string; status: string | null; additions: number; deletions: number }> {
  return (diff ?? [])
    .filter((d) => d?.file)
    .slice(0, 2000)
    .map((d) => ({ file: String(d.file).slice(0, 1000), status: d.status ?? null, additions: d.additions ?? 0, deletions: d.deletions ?? 0 }))
}

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex")
}

/** Resolve `p` inside `root`, refusing anything that escapes it (including through symlinks). */
export async function resolveInside(root: string, p: string, mustExist: boolean): Promise<string> {
  const realRoot = await realpath(root)
  const abs = resolve(realRoot, isAbsolute(p) ? relative(root, p) : p)
  let checked = abs
  try {
    checked = await realpath(abs)
  } catch (err) {
    if (mustExist) throw new Error("File not found")
    checked = join(await realpath(dirname(abs)).catch(() => dirname(abs)), basename(abs))
  }
  const rel = relative(realRoot, checked)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only files inside the session's project folder can be opened")
  return checked
}

function displayPath(root: string, file: string) {
  const rel = relative(root, file)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : file
}

function simplePatch(file: string, before: string[], after: string[]) {
  const head = `--- a/${file}\n+++ b/${file}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`
  return [head, ...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)].join("\n")
}

/** File changes recorded by the agent's write / edit / multiedit / apply_patch tools. */
export function toolChanges(part: any, directory: string): DerivedChange[] {
  const input = part.state?.input ?? {}
  const meta = part.state?.metadata ?? {}
  const rel = (f: string) => displayPath(directory, isAbsolute(f) ? f : join(directory, f))
  const lines = (t: unknown) => (typeof t === "string" && t.length ? t.split("\n") : [])
  switch (part.tool) {
    case "write": {
      const file = input.filePath ?? input.file_path
      if (!file) return []
      const after = lines(input.content)
      const patch = typeof meta.diff === "string" && meta.diff ? meta.diff : simplePatch(rel(file), [], after)
      return [{ file: rel(file), status: meta.exists ? "modified" : "added", additions: meta.filediff?.additions ?? after.length, deletions: meta.filediff?.deletions ?? 0, patches: [patch] }]
    }
    case "edit": {
      const file = input.filePath ?? input.file_path
      if (!file) return []
      const before = lines(input.oldString ?? input.old_string)
      const after = lines(input.newString ?? input.new_string)
      const patch = typeof meta.diff === "string" && meta.diff ? meta.diff : simplePatch(rel(file), before, after)
      return [{ file: rel(file), status: "modified", additions: meta.filediff?.additions ?? after.length, deletions: meta.filediff?.deletions ?? before.length, patches: [patch] }]
    }
    case "multiedit": {
      const file = input.filePath ?? input.file_path
      if (!file || !Array.isArray(input.edits)) return []
      const before = input.edits.flatMap((e: any) => lines(e.oldString ?? e.old_string))
      const after = input.edits.flatMap((e: any) => lines(e.newString ?? e.new_string))
      return [{ file: rel(file), status: "modified", additions: after.length, deletions: before.length, patches: [simplePatch(rel(file), before, after)] }]
    }
    case "apply_patch":
    case "patch": {
      const text: string = input.patchText ?? input.patch ?? input.input ?? ""
      const out: DerivedChange[] = []
      let cur: DerivedChange | null = null
      for (const line of text.split("\n")) {
        const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
        if (m) {
          cur = { file: rel(m[2].trim()), status: m[1] === "Add" ? "added" : m[1] === "Delete" ? "deleted" : "modified", additions: 0, deletions: 0, patches: [`--- a/${rel(m[2].trim())}\n+++ b/${rel(m[2].trim())}`] }
          out.push(cur)
          continue
        }
        if (!cur || line.startsWith("*** ")) continue
        if (line.startsWith("+")) cur.additions++
        else if (line.startsWith("-")) cur.deletions++
        cur.patches[0] += `\n${line}`
      }
      return out
    }
    default:
      return []
  }
}

function describeInput(tool: string, input: any): string | null {
  if (!input || typeof input !== "object") return null
  return input.command ?? input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? null
}

function describeAction(part: PartSync): string {
  const title = part.toolTitle ?? part.tool ?? "tool"
  switch (part.tool) {
    case "bash":
      return `Running ${title}`
    case "edit":
    case "write":
    case "apply_patch":
      return `Editing ${title}`
    case "read":
      return `Reading ${title}`
    case "grep":
    case "glob":
      return `Searching ${title}`
    default:
      return `${part.tool}: ${title}`
  }
}

function stripDirectory<T extends object>(a: T): Omit<T, "directory"> {
  const { directory: _d, ...rest } = a as T & { directory?: string }
  return rest
}

function latestBy<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>()
  for (const item of items) map.set(key(item), item)
  return [...map.values()]
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
