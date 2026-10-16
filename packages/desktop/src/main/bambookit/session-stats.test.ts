import { describe, expect, mock, test } from "bun:test"

const saved = new Map<string, unknown>()
mock.module("./secure-store", () => ({
  readState: async (name: string) => saved.get(name) ?? null,
  writeState: async (name: string, value: unknown) => void saved.set(name, JSON.parse(JSON.stringify(value))),
}))

const { SessionStatsTracker } = await import("./session-stats")

const bash = (id: string, command: string, exit = 0) => ({
  id,
  tool: "bash",
  state: { status: exit === 0 ? "completed" : "error", input: { command }, metadata: { exit } },
})

describe("SessionStatsTracker", () => {
  test("counts each tool part and prompt once", () => {
    const t = new SessionStatsTracker()
    expect(t.onToolFinished("s", bash("p1", "npm test"), [])).toBe(true)
    expect(t.onToolFinished("s", bash("p1", "npm test"), [])).toBe(false)
    expect(t.onPrompt("s", "m1", "please fix the login bug")).toBe(true)
    expect(t.onPrompt("s", "m1", "please fix the login bug")).toBe(false)
    const s = t.get("s")!
    expect(s.toolCalls).toBe(1)
    expect(s.testsRun).toBe(1)
    expect(s.testsPassed).toBe(1)
    expect(s.prompts).toBe(1)
    expect(s.bugPrompts).toBe(1)
    expect(s.debugging).toBe(true)
  })

  test("classifies shell commands", () => {
    const t = new SessionStatsTracker()
    t.onToolFinished("s", bash("a", "bun test", 1), [])
    t.onToolFinished("s", bash("b", 'git add -A && git commit -m "x"'), [])
    t.onToolFinished("s", bash("c", "git checkout -b feature/login"), [])
    t.onToolFinished("s", bash("d", "npm install zod"), [])
    t.onToolFinished("s", bash("e", "npx wrangler deploy"), [])
    t.onToolFinished("s", bash("f", "gh pr create --fill"), [])
    t.onToolFinished("s", bash("g", "git merge main"), [])
    t.onToolFinished("s", bash("h", "npm install"), [])
    const s = t.get("s")!
    expect(s.terminalCommands).toBe(8)
    expect(s.testsRun).toBe(1)
    expect(s.testsFailed).toBe(1)
    expect(s.commits).toBe(1)
    expect(s.branches).toBe(1)
    expect(s.packagesInstalled).toBe(1)
    expect(s.cloudDeployments).toBe(1)
    expect(s.deployments).toBe(1)
    expect(s.pullRequests).toBe(1)
    expect(s.merges).toBe(1)
  })

  test("counts file changes, docs, sub-agents and MCP tools", () => {
    const t = new SessionStatsTracker()
    t.onToolFinished("s", { id: "e1", tool: "write", state: { status: "completed" } }, [{ file: "README.md", status: "added", additions: 10, deletions: 0 }])
    t.onToolFinished("s", { id: "e2", tool: "edit", state: { status: "completed" } }, [{ file: "src/a.ts", status: "modified", additions: 3, deletions: 2 }])
    t.onToolFinished("s", { id: "t1", tool: "task", state: { status: "completed", input: { subagent_type: "explore" } } }, [])
    t.onToolFinished("s", { id: "m1", tool: "github_create_issue", state: { status: "completed" } }, [])
    const s = t.get("s")!
    expect(s.edits).toBe(2)
    expect(s.filesCreated).toBe(1)
    expect(s.filesModified).toBe(1)
    expect(s.linesAdded).toBe(13)
    expect(s.linesDeleted).toBe(2)
    expect(s.docFiles).toBe(1)
    expect(s.subagentTasks).toBe(1)
    expect(s.agents).toEqual(["explore"])
    expect(s.mcpToolCalls).toBe(1)
    expect(s.mcpTools).toEqual(["github_create_issue"])
  })

  test("restored counters are not counted twice", async () => {
    const t = new SessionStatsTracker()
    t.onToolFinished("s", bash("p1", "git commit -m x"), [])
    await new Promise((r) => setTimeout(r, 2100))
    const restarted = new SessionStatsTracker()
    await restarted.load()
    expect(restarted.get("s")!.commits).toBe(1)
    expect(restarted.onToolFinished("s", bash("p1", "git commit -m x"), [])).toBe(false)
    expect(restarted.get("s")!.commits).toBe(1)
  })
})
