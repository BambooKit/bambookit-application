import { FileIcon } from "@opencode-ai/ui/file-icon"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"

/**
 * Project diagram in the spirit of gitdiagram.com: the project's components (folders and top-level
 * source files) drawn as a flowchart, with arrows for the references the code actually makes
 * (imports, requires, <script src>, <link href>, CSS @import, Python imports). Built from the files on
 * disk through the local engine every time; nothing is generated or invented.
 */

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", "coverage",
  "target", "vendor", "__pycache__", ".venv", "venv", ".gradle", ".idea", ".vscode", "bin", "obj",
])
const SOURCE = /\.(m?[jt]sx?|cjs|py|html?|css|scss|sass|less|vue|svelte|kt|kts|java|go|rs|rb|php|cs|swift|dart|c|cc|cpp|h|hpp)$/i
const RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".css", ".scss", ".py", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py"]
const MAX_FILES = 800
const MAX_READ = 300
const MAX_BYTES = 200_000

type Graph = {
  files: string[]
  nodes: Array<{ id: string; label: string; files: string[]; folder: boolean; where: string }>
  edges: Array<{ from: string; to: string; count: number }>
  truncated: boolean
}

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")

function join(base: string, rel: string) {
  const out: string[] = base ? base.split("/") : []
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") out.pop()
    else out.push(seg)
  }
  return out.join("/")
}

function references(file: string, text: string): string[] {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
  const out: string[] = []
  const local = (spec: string) => {
    const s = spec.split(/[?#]/)[0]
    if (!s || /^[a-z]+:/i.test(s) || s.startsWith("//") || s.startsWith("data:")) return
    if (s.startsWith("/")) out.push(norm(s.slice(1)))
    else if (s.startsWith(".") || /\.(html?|css|js|mjs|ts)$/i.test(s)) out.push(join(dir, s))
  }
  if (/\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(file))
    for (const m of text.matchAll(/(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm))
      local(m[1] ?? m[2] ?? m[3] ?? m[4])
  if (/\.html?$/i.test(file))
    for (const m of text.matchAll(/<(?:script|link|a|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) local(m[1])
  if (/\.(s?css|sass|less)$/i.test(file)) for (const m of text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) local(m[1])
  if (/\.py$/i.test(file))
    for (const m of text.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm)) {
      const mod = m[1] ?? m[2]
      if (mod.startsWith(".")) {
        const up = mod.match(/^\.+/)![0].length
        out.push(join(dir, "../".repeat(up - 1) + mod.slice(up).replaceAll(".", "/")))
      } else out.push(mod.replaceAll(".", "/"))
    }
  return out
}

/** Folder each file belongs to on the diagram: up to two levels deep, so components stay readable. */
function componentOf(file: string, depth: number) {
  const parts = file.split("/")
  if (parts.length === 1 || depth >= parts.length) return file
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/") + "/"
}

async function build(sdk: ReturnType<typeof useSDK>): Promise<Graph> {
  const client = sdk().client
  const files: string[] = []
  const queue = [""]
  let truncated = false
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift()!
    const entries = await client.file.list({ path: dir }).then((x) => x.data ?? [], () => [])
    for (const e of entries) {
      const path = norm(e.path)
      if (e.ignored || e.name.startsWith(".") && e.type === "directory") continue
      if (e.type === "directory") {
        if (!SKIP_DIRS.has(e.name) && path.split("/").length < 8) queue.push(path)
      } else if (SOURCE.test(e.name)) files.push(path)
      if (files.length >= MAX_FILES) truncated = true
    }
  }
  const set = new Set(files)
  const resolve = (target: string) => {
    for (const ext of RESOLVE_EXT) if (set.has(target + ext)) return target + ext
  }

  const refs = new Map<string, string[]>()
  const toRead = files.slice(0, MAX_READ)
  if (files.length > MAX_READ) truncated = true
  let next = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < toRead.length) {
        const file = toRead[next++]
        const res = await client.file.read({ path: file }).then((x) => x.data, () => undefined)
        if (!res || res.type !== "text" || res.content.length > MAX_BYTES) continue
        refs.set(file, references(file, res.content).flatMap((t) => resolve(t) ?? []))
      }
    }),
  )

  // Two folder levels when the project is nested under a single top folder (src/, app/), else one.
  const tops = new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))
  // Small projects: one box per file. Larger ones: one box per folder (up to two levels deep).
  const depth = files.length <= 40 ? 99 : tops.size <= 2 ? 2 : 1
  const groups = new Map<string, string[]>()
  for (const f of files) {
    const id = componentOf(f, depth)
    groups.set(id, [...(groups.get(id) ?? []), f])
  }
  const counts = new Map<string, number>()
  for (const [file, targets] of refs)
    for (const t of targets) {
      const a = componentOf(file, depth)
      const b = componentOf(t, depth)
      if (a !== b) counts.set(`${a}\n${b}`, (counts.get(`${a}\n${b}`) ?? 0) + 1)
    }
  return {
    files,
    truncated,
    nodes: [...groups].map(([id, fs]) => ({
      id,
      label: id.endsWith("/") ? id.slice(0, -1) : id.split("/").pop()!,
      folder: id.endsWith("/"),
      where: id.endsWith("/") ? "" : id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "",
      files: fs.sort(),
    })),
    edges: [...counts].map(([k, count]) => {
      const [from, to] = k.split("\n")
      return { from, to, count }
    }),
  }
}

/** Top-down ranks: components nothing points at (entry points) first, then what they use. */
function layout(graph: Graph) {
  const W = 190
  const H = 58
  const GAP_X = 36
  const GAP_Y = 84
  const incoming = new Map(graph.nodes.map((n) => [n.id, 0]))
  const out = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]))
  for (const e of graph.edges) {
    out.get(e.from)!.push(e.to)
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  }
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string, r: number) => {
    if (visiting.has(id) || (rank.get(id) ?? -1) >= r || r > 40) return
    rank.set(id, r)
    visiting.add(id)
    for (const t of out.get(id) ?? []) visit(t, r + 1)
    visiting.delete(id)
  }
  const roots = graph.nodes.filter((n) => !incoming.get(n.id))
  for (const n of roots.length ? roots : graph.nodes.slice(0, 1)) visit(n.id, 0)
  for (const n of graph.nodes) if (!rank.has(n.id)) rank.set(n.id, 0)
  // Unconnected components go on their own bottom row so the flow above stays clear.
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]))
  const maxRank = Math.max(0, ...[...rank].filter(([id]) => linked.has(id)).map(([, r]) => r))
  for (const n of graph.nodes) if (!linked.has(n.id)) rank.set(n.id, linked.size ? maxRank + 1 : 0)

  const rows = new Map<number, string[]>()
  for (const n of graph.nodes) rows.set(rank.get(n.id)!, [...(rows.get(rank.get(n.id)!) ?? []), n.id])
  const perRow = 6
  const pos = new Map<string, { x: number; y: number }>()
  let y = 30
  let width = 0
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(r)!.sort()
    for (let i = 0; i < ids.length; i += perRow) {
      const chunk = ids.slice(i, i + perRow)
      chunk.forEach((id, j) => pos.set(id, { x: 30 + j * (W + GAP_X), y }))
      width = Math.max(width, 30 + chunk.length * (W + GAP_X))
      y += H + GAP_Y
    }
  }
  return { pos, W, H, width: Math.max(width, 400), height: y }
}

export function ProjectDiagram(props: {
  touched: Map<string, "created" | "edited" | "deleted" | "read">
  onOpenFile: (path: string) => void
}) {
  const sdk = useSDK()
  const [graph, { refetch }] = createResource(() => sdk().directory, () => build(sdk))
  const [selected, setSelected] = createSignal<string | null>(null)
  const [zoom, setZoom] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  let drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null

  const laid = createMemo(() => (graph() ? layout(graph()!) : null))
  const node = createMemo(() => graph()?.nodes.find((n) => n.id === selected()))
  const activity = (files: string[]) => {
    const kinds = new Set(files.map((f) => props.touched.get(f)).filter(Boolean))
    if (kinds.has("created")) return "var(--icon-diff-add-base)"
    if (kinds.has("edited") || kinds.has("deleted")) return "var(--icon-diff-modified-base)"
    if (kinds.has("read")) return "var(--icon-interactive-base)"
  }

  return (
    <div class="flex h-full min-h-0">
      <div
        class="relative flex-1 min-w-0 overflow-hidden cursor-grab active:cursor-grabbing"
        onWheel={(e) => {
          e.preventDefault()
          setZoom((z) => Math.max(0.3, Math.min(2.5, z * (e.deltaY < 0 ? 1.1 : 0.9))))
        }}
        onPointerDown={(e) => (drag = { x: e.clientX, y: e.clientY, px: pan().x, py: pan().y, moved: false })}
        onPointerMove={(e) => {
          if (!drag) return
          if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true
          if (drag.moved) setPan({ x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y })
        }}
        onPointerUp={() => setTimeout(() => (drag = null))}
        onPointerLeave={() => (drag = null)}
      >
        <div class="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-background-base/80 p-0.5">
          <ToolButton onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))}>+</ToolButton>
          <ToolButton onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))}>−</ToolButton>
          <ToolButton onClick={() => (setZoom(1), setPan({ x: 0, y: 0 }))}>Fit</ToolButton>
          <ToolButton onClick={() => void refetch()}>Rescan</ToolButton>
        </div>
        <Show
          when={laid()}
          fallback={
            <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
              {graph.error ? `Could not read the project: ${String(graph.error?.message ?? graph.error)}` : "Reading the project…"}
            </div>
          }
        >
          {(l) => (
            <Show
              when={graph()!.nodes.length}
              fallback={<div class="h-full flex items-center justify-center text-12-regular text-text-weak">No source files found in this project.</div>}
            >
              <svg
                width={l().width}
                height={l().height}
                class="select-none"
                style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`, "transform-origin": "0 0" }}
              >
                <defs>
                  <marker id="bk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--icon-weak-base)" />
                  </marker>
                  <marker id="bk-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-strong)" />
                  </marker>
                </defs>
                <For each={graph()!.edges}>
                  {(e) => {
                    const a = () => l().pos.get(e.from)!
                    const b = () => l().pos.get(e.to)!
                    const hot = () => selected() === e.from || selected() === e.to
                    const d = () => {
                      const x1 = a().x + l().W / 2
                      const x2 = b().x + l().W / 2
                      const down = b().y > a().y
                      const y1 = down ? a().y + l().H : a().y
                      const y2 = down ? b().y : b().y + l().H
                      const bend = down ? 40 : -40
                      return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
                    }
                    return (
                      <path
                        d={d()}
                        fill="none"
                        stroke={hot() ? "var(--text-strong)" : "var(--border-strong-base)"}
                        stroke-width={hot() ? 2 : 1.2}
                        opacity={selected() && !hot() ? 0.25 : 1}
                        marker-end={hot() ? "url(#bk-arrow-hot)" : "url(#bk-arrow)"}
                      >
                        <title>{`${e.from} → ${e.to} · ${e.count} reference${e.count === 1 ? "" : "s"}`}</title>
                      </path>
                    )
                  }}
                </For>
                <For each={graph()!.nodes}>
                  {(n) => {
                    const p = () => l().pos.get(n.id)!
                    const mark = () => activity(n.files)
                    return (
                      <g
                        transform={`translate(${p().x}, ${p().y})`}
                        class="cursor-pointer"
                        opacity={selected() && selected() !== n.id && !graph()!.edges.some((e) => (e.from === selected() && e.to === n.id) || (e.to === selected() && e.from === n.id)) ? 0.4 : 1}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          if (drag?.moved) return
                          if (!n.folder) return props.onOpenFile(n.files[0])
                          setSelected(selected() === n.id ? null : n.id)
                        }}
                      >
                        <rect
                          width={l().W}
                          height={l().H}
                          rx="10"
                          fill="var(--surface-raised-base)"
                          stroke={selected() === n.id ? "var(--text-strong)" : (mark() ?? "var(--border-weak-base)")}
                          stroke-width={selected() === n.id || mark() ? 2 : 1}
                        />
                        <text x="14" y="24" fill="var(--text-strong)" font-size="13" font-weight="600">
                          {(n.folder ? "▣ " : "") + (n.label.length > 22 ? "…" + n.label.slice(-21) : n.label)}
                        </text>
                        <text x="14" y="43" fill="var(--text-weak)" font-size="11">
                          {n.folder ? `${n.files.length} file${n.files.length === 1 ? "" : "s"}` : n.where ? `${n.where}/` : "project root"}
                          {n.files.some((f) => props.touched.has(f)) ? " · used in this session" : ""}
                        </text>
                      </g>
                    )
                  }}
                </For>
              </svg>
            </Show>
          )}
        </Show>
      </div>
      <Show when={node()}>
        {(n) => (
          <div class="w-64 shrink-0 border-l border-border-weak-base flex flex-col min-h-0">
            <div class="px-3 py-2 border-b border-border-weak-base">
              <div class="text-12-medium text-text-strong truncate">{n().label}</div>
              <div class="text-11-regular text-text-weak">
                {n().files.length} files · uses {graph()!.edges.filter((e) => e.from === n().id).length} · used by{" "}
                {graph()!.edges.filter((e) => e.to === n().id).length}
              </div>
            </div>
            <div class="flex-1 min-h-0 overflow-auto py-1">
              <For each={n().files}>
                {(f) => (
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-surface-raised-base-hover"
                    title={f}
                    onClick={() => props.onOpenFile(f)}
                  >
                    <FileIcon node={{ path: f, type: "file" }} class="size-4 shrink-0" />
                    <span class="text-12-regular text-text-base truncate">{f.slice(n().id.length)}</span>
                    <Show when={props.touched.get(f)}>
                      {(kind) => (
                        <span
                          class="ml-auto size-1.5 rounded-full shrink-0"
                          title={kind()}
                          style={{
                            background:
                              kind() === "created" ? "var(--icon-diff-add-base)" : kind() === "read" ? "var(--icon-interactive-base)" : "var(--icon-diff-modified-base)",
                          }}
                        />
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <Show when={graph()?.truncated}>
        <div class="absolute bottom-2 left-3 text-11-regular text-text-weak">Large project: showing the first {MAX_FILES} source files.</div>
      </Show>
    </div>
  )
}

function ToolButton(props: { onClick: () => void; children: string }) {
  return (
    <button type="button" class="h-6 px-2 rounded text-11-medium text-text-base hover:bg-surface-raised-base-hover" onClick={props.onClick}>
      {props.children}
    </button>
  )
}
