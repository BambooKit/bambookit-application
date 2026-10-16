import { readState, writeState } from "./secure-store"

/**
 * Per-session work statistics (API capability "session-stats"). The API turns them into the Profile's
 * statistics and achievements. Counters are derived from the agent's own tool calls and prompts, each part
 * counted once, and persisted: the API stores what was sent last, so counters must survive app restarts.
 */

export interface SessionStats {
  filesCreated: number
  filesModified: number
  filesDeleted: number
  filesRenamed: number
  linesAdded: number
  linesDeleted: number
  edits: number
  testsRun: number
  testsPassed: number
  testsFailed: number
  commits: number
  deployments: number
  debugging: boolean
  prompts: number
  bugPrompts: number
  toolCalls: number
  terminalCommands: number
  subagentTasks: number
  mcpToolCalls: number
  mcpTools: string[]
  agents: string[]
  packagesInstalled: number
  branches: number
  merges: number
  pullRequests: number
  cloudDeployments: number
  cleanups: number
  docFiles: number
  refactoring: boolean
}

export interface FileChange {
  file: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
}

const empty = (): SessionStats => ({
  filesCreated: 0, filesModified: 0, filesDeleted: 0, filesRenamed: 0, linesAdded: 0, linesDeleted: 0, edits: 0,
  testsRun: 0, testsPassed: 0, testsFailed: 0, commits: 0, deployments: 0, debugging: false, prompts: 0, bugPrompts: 0,
  toolCalls: 0, terminalCommands: 0, subagentTasks: 0, mcpToolCalls: 0, mcpTools: [], agents: [], packagesInstalled: 0,
  branches: 0, merges: 0, pullRequests: 0, cloudDeployments: 0, cleanups: 0, docFiles: 0, refactoring: false,
})

/** OpenCode's built-in tools; any other tool name is an MCP tool ("<server>_<tool>"). */
const BUILTIN_TOOLS = new Set([
  "bash", "edit", "write", "read", "grep", "glob", "list", "patch", "apply_patch", "multiedit", "todowrite", "todoread",
  "webfetch", "websearch", "codesearch", "task", "skill", "question", "batch", "invalid", "plan_enter", "plan_exit",
])
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])

const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(jest|vitest|mocha|pytest|phpunit|rspec|playwright\s+test)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bgradlew?\s+test\b|\bmvn\s+test\b|\bbun\s+test\b/
const INSTALL_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+[^-\s]|\bpip3?\s+install\s+[^-\s]|\bcargo\s+add\b|\bgo\s+get\b|\bbrew\s+install\b|\bgem\s+install\b|\bcomposer\s+require\b|\bdotnet\s+add\s+package\b/
const CLOUD_DEPLOY = /\b(vercel(\s+--prod)?|netlify\s+deploy|wrangler\s+(deploy|publish)|fly(ctl)?\s+deploy|firebase\s+deploy|gcloud\s+(app|run)\s+deploy|aws\s+\S+\s+deploy|heroku\s+\S*deploy|railway\s+up|render\s+deploy|sst\s+deploy|serverless\s+deploy|cdk\s+deploy|amplify\s+publish)\b/
const DEPLOY = /\bdeploy\b|\bgit\s+push\s+\S*\s*(production|prod|heroku|dokku)\b/
const CLEANUP = /\brm\s+-[a-z]*r|\bgit\s+clean\b|\b(npm|pnpm|yarn)\s+(prune|dedupe)\b|\bgit\s+branch\s+-[dD]\b/
const DOC_FILE = /(^|\/)(readme|changelog|contributing|docs?\/)|\.(md|mdx|rst|adoc)$/i
const BUG_PROMPT = /\b(bug|fix|broken|crash(es|ing)?|error|exception|fail(s|ing|ed)?|not working|doesn'?t work|issue|stack ?trace)\b/i
const REFACTOR_PROMPT = /\b(refactor|clean ?up|restructure|simplif(y|ication)|rename)\b/i

export class SessionStatsTracker {
  private stats = new Map<string, SessionStats>()
  private seen = new Set<string>()
  private saveTimer: NodeJS.Timeout | null = null

  async load() {
    const saved = await readState<{ stats: Record<string, Partial<SessionStats>>; seen: string[] }>("session-stats")
    for (const [id, s] of Object.entries(saved?.stats ?? {})) this.stats.set(id, { ...empty(), ...s })
    for (const key of saved?.seen ?? []) this.seen.add(key)
  }

  get(sessionId: string): SessionStats | undefined {
    return this.stats.get(sessionId)
  }

  forget(sessionId: string) {
    if (this.stats.delete(sessionId)) this.scheduleSave()
  }

  /** A prompt the user sent (counted once per message). Returns true when the stats changed. */
  onPrompt(sessionId: string, messageId: string, text: string): boolean {
    if (!this.once(`prompt:${messageId}`)) return false
    const s = this.for(sessionId)
    s.prompts++
    if (BUG_PROMPT.test(text)) {
      s.bugPrompts++
      s.debugging = true
    }
    if (REFACTOR_PROMPT.test(text)) s.refactoring = true
    this.scheduleSave()
    return true
  }

  /** A tool call that finished (completed or error), with the file changes it made. Returns true when counted. */
  onToolFinished(sessionId: string, part: any, changes: FileChange[]): boolean {
    if (!this.once(`tool:${part.id}`)) return false
    const s = this.for(sessionId)
    const tool = String(part.tool ?? "")
    const input = part.state?.input ?? {}
    const ok = part.state?.status === "completed"
    s.toolCalls++

    if (EDIT_TOOLS.has(tool)) {
      s.edits++
      for (const c of changes) {
        if (c.status === "added") s.filesCreated++
        else if (c.status === "deleted") s.filesDeleted++
        else s.filesModified++
        s.linesAdded += c.additions
        s.linesDeleted += c.deletions
        if (DOC_FILE.test(c.file)) s.docFiles++
      }
    } else if (tool === "bash") {
      s.terminalCommands++
      this.onShellCommand(s, String(input.command ?? ""), ok, part.state?.metadata?.exit)
    } else if (tool === "task") {
      s.subagentTasks++
      const agent = String(input.subagent_type ?? input.agent ?? "").slice(0, 100)
      if (agent && !s.agents.includes(agent) && s.agents.length < 50) s.agents.push(agent)
    } else if (tool && !BUILTIN_TOOLS.has(tool) && !tool.startsWith("lsp")) {
      s.mcpToolCalls++
      const name = tool.slice(0, 100)
      if (!s.mcpTools.includes(name) && s.mcpTools.length < 200) s.mcpTools.push(name)
    }
    this.scheduleSave()
    return true
  }

  private onShellCommand(s: SessionStats, command: string, ok: boolean, exit: unknown) {
    const cmd = command.toLowerCase()
    if (TEST_COMMAND.test(cmd)) {
      s.testsRun++
      const passed = ok && (exit === undefined || exit === null || Number(exit) === 0)
      if (passed) s.testsPassed++
      else s.testsFailed++
    }
    if (/\bgit\s+commit\b/.test(cmd)) s.commits++
    if (/\bgit\s+merge\b|\bgh\s+pr\s+merge\b/.test(cmd)) s.merges++
    if (/\bgit\s+(checkout|switch)\s+-[bc]\b|\bgit\s+branch\s+(?!-)[\w./-]+/.test(cmd)) s.branches++
    if (/\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b/.test(cmd)) s.pullRequests++
    if (/\bgit\s+mv\b|(^|[;&|]\s*)mv\s/.test(cmd)) s.filesRenamed++
    if (INSTALL_COMMAND.test(cmd)) s.packagesInstalled++
    if (CLOUD_DEPLOY.test(cmd)) {
      s.cloudDeployments++
      s.deployments++
    } else if (DEPLOY.test(cmd)) s.deployments++
    if (CLEANUP.test(cmd)) s.cleanups++
  }

  private for(sessionId: string) {
    let s = this.stats.get(sessionId)
    if (!s) {
      s = empty()
      this.stats.set(sessionId, s)
    }
    return s
  }

  private once(key: string) {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    // Keep the de-duplication set bounded; old parts never come back as "finished" again.
    if (this.seen.size > 50_000) {
      const keep = [...this.seen].slice(-25_000)
      this.seen = new Set(keep)
    }
    return true
  }

  private scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void writeState("session-stats", { stats: Object.fromEntries(this.stats), seen: [...this.seen].slice(-25_000) }).catch(() => undefined)
    }, 2000)
  }
}
