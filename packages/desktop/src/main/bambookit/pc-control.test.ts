import { beforeEach, describe, expect, mock, test } from "bun:test"

const saved = new Map<string, unknown>()
const blocker = { started: 0, stopped: 0 }
const fakeBlocker = async () => ({ start: () => ++blocker.started, stop: () => void blocker.stopped++ })
mock.module("./secure-store", () => ({
  readState: async (name: string) => saved.get(name) ?? null,
  writeState: async (name: string, value: unknown) => void saved.set(name, JSON.parse(JSON.stringify(value))),
}))

const { PcSettingsStore } = await import("./pc-control")

describe("PcSettingsStore", () => {
  beforeEach(() => {
    saved.clear()
    blocker.started = blocker.stopped = 0
  })

  test("Ask mode never auto-approves", async () => {
    const store = new PcSettingsStore(fakeBlocker)
    await store.load()
    expect(store.autoApproves("s1", "edit")).toBe(false)
    expect(store.autoApproves("s1", "bash")).toBe(false)
  })

  test("Auto mode approves file edits only", async () => {
    const store = new PcSettingsStore(fakeBlocker)
    await store.load()
    await store.setApprovalMode("edits")
    expect(store.autoApproves("s1", "edit")).toBe(true)
    expect(store.autoApproves("s1", "write")).toBe(true)
    expect(store.autoApproves("s1", "bash")).toBe(false)
    expect(store.autoApproves("s1", "webfetch")).toBe(false)
  })

  test("a session override wins, and inherit removes it", async () => {
    const store = new PcSettingsStore(fakeBlocker)
    await store.load()
    await store.setApprovalMode("all", "s1")
    expect(store.autoApproves("s1", "bash")).toBe(true)
    expect(store.autoApproves("s2", "bash")).toBe(false)
    await store.setApprovalMode("inherit", "s1")
    expect(store.autoApproves("s1", "bash")).toBe(false)
    await expect(store.setApprovalMode("inherit")).rejects.toThrow()
  })

  test("keep awake holds one power blocker and is not restored after a restart", async () => {
    const store = new PcSettingsStore(fakeBlocker)
    await store.load()
    await store.setKeepAwake(true)
    await store.setKeepAwake(true)
    expect(blocker.started).toBe(1)
    await store.setKeepAwake(false)
    expect(blocker.stopped).toBe(1)
    await store.setKeepAwake(true)

    const restarted = new PcSettingsStore(fakeBlocker)
    await restarted.load()
    expect(restarted.get().keepAwake).toBe(false)
  })

  test("settings persist and notify listeners", async () => {
    const store = new PcSettingsStore(fakeBlocker)
    await store.load()
    const seen: unknown[] = []
    store.onChange((s) => seen.push(s))
    await store.setAllowRemoteControl(true)
    await store.setApprovalMode("edits")
    expect(seen.length).toBe(2)

    const restarted = new PcSettingsStore(fakeBlocker)
    await restarted.load()
    expect(restarted.get()).toEqual({ approvalMode: "edits", keepAwake: false, allowRemoteControl: true, phoneChatAnySession: true })
  })
})
