import { FileIcon } from "@opencode-ai/ui/file-icon"
import type { Part } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { ProjectDiagram } from "./project-diagram"

/**
 * Session file map: every file this session read, created, edited or deleted, laid out as a
 * folder tree. Built from the session's own tool calls plus the panel's diff list; nothing is guessed.
 */

type Action = "read" | "created" | "edited" | "deleted"
type Entry = {
  /** Relative to the session's project folder (what the file browser opens). */
  path: string
  /** Relative to the git root (what the review panel's diff list uses). */
  diffPath: string
  actions: Set<Action>
  touches: number
  firstTurn: number
  lastTurn: number
  additions: number
  deletions: number
  failed: boolean
}
type Folder = { name: string; path: string; folders: Folder[]; files: Entry[] }
type Diff = { file: string; additions: number; deletions: number; status?: string }

const ACTION_COLOR: Record<Action, string> = {
  created: "var(--icon-diff-add-base)",
  edited: "var(--icon-diff-modified-base)",
  deleted: "var(--icon-diff-delete-base)",
  read: "var(--icon-weak-base)",
}
const ACTION_LABEL: Record<Action, string> = { created: "Created", edited: "Edited", deleted: "Deleted", read: "Read" }
const ORDER: Action[] = ["created", "edited", "deleted", "read"]

const slash = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "")
const isAbsolute = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith("/")

/** Absolute, forward-slash path; relative inputs are resolved against `base`. */
function absolute(base: string, input: string) {
  const file = slash(input).replace(/^\.\//, "")
  return isAbsolute(file) ? file : `${slash(base)}/${file}`
}

function relative(root: string, file: string) {
  const r = slash(root)
  if (r && file.toLowerCase().startsWith(r.toLowerCase() + "/")) return file.slice(r.length + 1)
  return file
}

function touched(part: Part, directory: string): Array<{ path: string; action: Action }> {
  if (part.type !== "tool") return []
  const state = part.state as { input?: Record<string, any>; metadata?: Record<string, any> }
  const input = state.input ?? {}
  const one = (action: Action) => {
    const file = input.filePath ?? input.file_path ?? input.path
    return typeof file === "string" && file ? [{ path: absolute(directory, file), action }] : []
  }
  switch (part.tool) {
    case "read":
      return one("read")
    case "edit":
    case "multiedit":
      return one("edited")
    case "write":
      return one(state.metadata?.exists === false ? "created" : "edited")
    case "apply_patch":
    case "patch": {
      const files = state.metadata?.files
      if (Array.isArray(files) && files.length)
        return files.map((f: any) => ({
          path: absolute(directory, String(f.movePath ?? f.filePath ?? f.relativePath)),
          action: f.type === "add" ? "created" : f.type === "delete" ? "deleted" : "edited",
        }))
      const text = String(input.patchText ?? input.patch ?? "")
      return [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => ({
        path: absolute(directory, m[2].trim()),
        action: m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "edited",
      }))
    }
  }
  return []
}

function buildTree(entries: Entry[]) {
  const root: Folder = { name: "", path: "", folders: [], files: [] }
  for (const entry of entries) {
    const parts = entry.path.split("/")
    let node = root
    for (const name of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${name}` : name
      let next = node.folders.find((f) => f.name === name)
      if (!next) node.folders.push((next = { name, path, folders: [], files: [] }))
      node = next
    }
    node.files.push(entry)
  }
  // Collapse single-child folder chains (src/app/components) so the map stays compact.
  const compact = (f: Folder): Folder => {
    let cur = { ...f, folders: f.folders.map(compact) }
    while (cur.name && cur.files.length === 0 && cur.folders.length === 1) {
      const only = cur.folders[0]
      cur = { ...only, name: `${cur.name}/${only.name}` }
    }
    return cur
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name))
    f.files.sort((a, b) => a.path.localeCompare(b.path))
    f.folders.forEach(sort)
  }
  const out = compact(root)
  sort(out)
  return out
}

function totals(f: Folder): { files: number; changed: number; additions: number; deletions: number } {
  const sub = f.folders.map(totals)
  return {
    files: f.files.length + sub.reduce((n, s) => n + s.files, 0),
    changed: f.files.filter((e) => [...e.actions].some((a) => a !== "read")).length + sub.reduce((n, s) => n + s.changed, 0),
    additions: f.files.reduce((n, e) => n + e.additions, 0) + sub.reduce((n, s) => n + s.additions, 0),
    deletions: f.files.reduce((n, e) => n + e.deletions, 0) + sub.reduce((n, s) => n + s.deletions, 0),
  }
}

export function SessionFileMap(props: {
  sessionID: string | undefined
  directory: string
  /** Git root the diff list is relative to. */
  worktree: string
  diffs: Diff[]
  onOpenFile: (path: string) => void
  onOpenDiff: (path: string) => void
}) {
  const sync = useSync()
  const [filter, setFilter] = createSignal<"all" | "changed" | "read">("all")
  const [mode, setMode] = createSignal<"files" | "diagram">("files")
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())

  const entries = createMemo(() => {
    const id = props.sessionID
    const map = new Map<string, Entry>()
    const get = (abs: string, turn: number) => {
      const key = abs.toLowerCase()
      let e = map.get(key)
      if (!e)
        map.set(key, (e = { path: relative(props.directory, abs), diffPath: relative(props.worktree, abs), actions: new Set(), touches: 0, firstTurn: turn, lastTurn: turn, additions: 0, deletions: 0, failed: false }))
      return e
    }
    let turn = 0
    for (const message of (id && sync().data.message[id]) || []) {
      if (message.role === "user") turn++
      for (const part of sync().data.part[message.id] ?? []) {
        for (const t of touched(part, props.directory)) {
          const e = get(t.path, turn)
          e.actions.add(t.action)
          e.touches++
          e.lastTurn = turn
          if (part.type === "tool" && part.state.status === "error") e.failed = true
        }
      }
    }
    // Line counts (and changes made outside the file tools, e.g. by shell commands) come from the diff list.
    for (const d of props.diffs) {
      // Turn 0: changed outside the file tools (e.g. by a shell command); no turn is known.
      const e = get(absolute(props.worktree, d.file), 0)
      e.diffPath = d.file
      e.additions = d.additions ?? 0
      e.deletions = d.deletions ?? 0
      if (d.status === "added") e.actions.add("created")
      else if (d.status === "deleted") e.actions.add("deleted")
      else if (!e.actions.has("created")) e.actions.add("edited")
    }
    return [...map.values()]
  })

  const visible = createMemo(() =>
    entries().filter((e) => {
      const changed = [...e.actions].some((a) => a !== "read")
      return filter() === "all" || (filter() === "changed" ? changed : !changed)
    }),
  )
  const tree = createMemo(() => buildTree(visible()))
  const count = (action: Action) => entries().filter((e) => e.actions.has(action)).length
  const readOnly = () => entries().filter((e) => [...e.actions].every((a) => a === "read")).length

  const toggle = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  const FolderView = (p: { folder: Folder; depth: number }) => {
    const t = createMemo(() => totals(p.folder))
    const open = () => !collapsed().has(p.folder.path)
    return (
      <div class="flex flex-col">
        <Show when={p.folder.name}>
          <button
            type="button"
            class="group flex items-center gap-2 h-7 pr-2 rounded-md text-left hover:bg-surface-raised-base-hover"
            style={{ "padding-left": `${p.depth * 16 + 4}px` }}
            onClick={() => toggle(p.folder.path)}
          >
            <span class="text-11-regular text-text-weak w-3 shrink-0">{open() ? "▾" : "▸"}</span>
            <FileIcon node={{ path: p.folder.path, type: "directory" }} class="size-4 shrink-0" />
            <span class="text-12-medium text-text-strong truncate">{p.folder.name}</span>
            <span class="ml-auto shrink-0 text-11-regular text-text-weak">
              {t().files} file{t().files === 1 ? "" : "s"}
              <Show when={t().additions || t().deletions}>
                {" · "}
                <span style={{ color: "var(--icon-diff-add-base)" }}>+{t().additions}</span>{" "}
                <span style={{ color: "var(--icon-diff-delete-base)" }}>−{t().deletions}</span>
              </Show>
            </span>
          </button>
        </Show>
        <Show when={open()}>
          <div
            class="flex flex-col"
            classList={{ "border-l border-border-weak-base": !!p.folder.name }}
            style={{ "margin-left": p.folder.name ? `${p.depth * 16 + 10}px` : undefined }}
          >
            <For each={p.folder.folders}>{(f) => <FolderView folder={f} depth={p.folder.name ? 1 : 0} />}</For>
            <For each={p.folder.files}>{(e) => <FileRow entry={e} indent={p.folder.name ? 12 : 4} />}</For>
          </div>
        </Show>
      </div>
    )
  }

  const FileRow = (p: { entry: Entry; indent: number }) => {
    const name = () => p.entry.path.split("/").pop() ?? p.entry.path
    const changed = () => [...p.entry.actions].some((a) => a !== "read")
    return (
      <div
        class="group flex items-center gap-2 min-h-8 pr-2 rounded-md hover:bg-surface-raised-base-hover cursor-pointer"
        style={{ "padding-left": `${p.indent}px` }}
        title={p.entry.path}
        onClick={() => (changed() ? props.onOpenDiff(p.entry.diffPath) : props.onOpenFile(p.entry.path))}
      >
        <FileIcon node={{ path: p.entry.path, type: "file" }} class="size-4 shrink-0" />
        <span class="text-12-regular text-text-base truncate">{name()}</span>
        <div class="flex items-center gap-2.5 shrink-0 pl-1">
          <For each={ORDER.filter((a) => p.entry.actions.has(a))}>
            {(a) => (
              <span class="flex items-center gap-1 text-11-regular text-text-weak">
                <span class="size-1.5 rounded-full" style={{ background: ACTION_COLOR[a] }} />
                {ACTION_LABEL[a]}
              </span>
            )}
          </For>
          <Show when={p.entry.failed}>
            <span class="text-11-regular" style={{ color: "var(--icon-critical-base)" }}>
              Failed
            </span>
          </Show>
        </div>
        <span class="ml-auto shrink-0 flex items-center gap-2 text-11-regular text-text-weak">
          <Show when={p.entry.additions || p.entry.deletions}>
            <span>
              <span style={{ color: "var(--icon-diff-add-base)" }}>+{p.entry.additions}</span>{" "}
              <span style={{ color: "var(--icon-diff-delete-base)" }}>−{p.entry.deletions}</span>
            </span>
          </Show>
          <Show when={p.entry.lastTurn > 0}>
            <span>{p.entry.firstTurn === p.entry.lastTurn ? `turn ${p.entry.firstTurn}` : `turns ${p.entry.firstTurn}–${p.entry.lastTurn}`}</span>
          </Show>
          <span class="hidden group-hover:flex gap-1">
            <button
              type="button"
              class="px-1.5 rounded text-11-medium text-text-base hover:bg-surface-raised-base-active"
              onClick={(ev) => {
                ev.stopPropagation()
                props.onOpenFile(p.entry.path)
              }}
            >
              Open
            </button>
            <Show when={changed()}>
              <button
                type="button"
                class="px-1.5 rounded text-11-medium text-text-base hover:bg-surface-raised-base-active"
                onClick={(ev) => {
                  ev.stopPropagation()
                  props.onOpenDiff(p.entry.diffPath)
                }}
              >
                Diff
              </button>
            </Show>
          </span>
        </span>
      </div>
    )
  }

  const Chip = (p: { value: "all" | "changed" | "read"; label: string }) => (
    <button
      type="button"
      class="h-6 px-2 rounded-md text-11-medium"
      classList={{
        "bg-surface-raised-base-active text-text-strong": filter() === p.value,
        "text-text-weak hover:text-text-base": filter() !== p.value,
      }}
      onClick={() => setFilter(p.value)}
    >
      {p.label}
    </button>
  )

  const touchedMap = createMemo(() => {
    const out = new Map<string, Action>()
    for (const e of entries()) out.set(e.path, ORDER.find((a) => e.actions.has(a)) ?? "read")
    return out
  })

  const ModeButton = (p: { value: "files" | "diagram"; label: string }) => (
    <button
      type="button"
      class="h-6 px-2.5 rounded-md text-12-medium"
      classList={{
        "bg-surface-raised-base-active text-text-strong": mode() === p.value,
        "text-text-weak hover:text-text-base": mode() !== p.value,
      }}
      onClick={() => setMode(p.value)}
    >
      {p.label}
    </button>
  )

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="shrink-0 flex items-center gap-1 px-3 pt-2">
        <ModeButton value="files" label="Session files" />
        <ModeButton value="diagram" label="Project diagram" />
      </div>
      <Show when={mode() === "diagram"}>
        <div class="relative flex-1 min-h-0 mt-2 border-t border-border-weak-base">
          <ProjectDiagram touched={touchedMap()} onOpenFile={props.onOpenFile} />
        </div>
      </Show>
      <Show when={mode() === "files"}>
      <div class="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-border-weak-base">
        <div class="flex items-center gap-3 text-12-regular text-text-weak">
          <span class="text-text-strong text-12-medium">{entries().length} files</span>
          <For each={ORDER}>
            {(a) => (
              <Show when={a === "read" ? readOnly() : count(a)}>
                <span class="flex items-center gap-1.5">
                  <span class="size-2 rounded-full" style={{ background: ACTION_COLOR[a] }} />
                  {a === "read" ? readOnly() : count(a)} {a === "read" ? "read only" : ACTION_LABEL[a].toLowerCase()}
                </span>
              </Show>
            )}
          </For>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <Chip value="all" label="All" />
          <Chip value="changed" label="Changed" />
          <Chip value="read" label="Read only" />
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-auto px-3 py-2">
        <Show
          when={visible().length}
          fallback={
            <div class="h-full flex items-center justify-center text-12-regular text-text-weak text-center px-6">
              {entries().length ? "No files match this filter." : "This session hasn't read or changed any files yet."}
            </div>
          }
        >
          <FolderView folder={tree()} depth={0} />
        </Show>
      </div>
      </Show>
    </div>
  )
}
