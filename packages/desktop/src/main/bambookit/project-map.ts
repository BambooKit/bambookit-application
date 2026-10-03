import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Session file map and project diagram, computed on this PC and handed to the phone and website
 * through the live relay (the API stores neither). Mirrors what BambooKit Desktop shows in its
 * File map tab: files come from the session's own tool calls plus its diff; diagram arrows come from
 * references the code really makes (imports, require, <script src>, <link href>, CSS/Python imports).
 */

export type FileAction = "created" | "edited" | "deleted" | "read"

export interface FileMapEntry {
  path: string
  actions: FileAction[]
  firstTurn: number
  lastTurn: number
  additions: number
  deletions: number
  failed: boolean
}

const slash = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "")
const isAbsolute = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith("/")

function relative(root: string, input: string) {
  const file = slash(input).replace(/^\.\//, "")
  const r = slash(root)
  if (r && file.toLowerCase().startsWith(r.toLowerCase() + "/")) return file.slice(r.length + 1)
  return file
}

function touched(part: any): Array<{ path: string; action: FileAction }> {
  if (part?.type !== "tool") return []
  const input = part.state?.input ?? {}
  const meta = part.state?.metadata ?? {}
  const one = (action: FileAction) => {
    const file = input.filePath ?? input.file_path ?? input.path
    return typeof file === "string" && file ? [{ path: file, action }] : []
  }
  switch (part.tool) {
    case "read":
      return one("read")
    case "edit":
    case "multiedit":
      return one("edited")
    case "write":
      return one(meta.exists === false ? "created" : "edited")
    case "apply_patch":
    case "patch": {
      if (Array.isArray(meta.files) && meta.files.length)
        return meta.files.map((f: any) => ({
          path: String(f.movePath ?? f.filePath ?? f.relativePath),
          action: f.type === "add" ? "created" : f.type === "delete" ? "deleted" : "edited",
        }))
      const text = String(input.patchText ?? input.patch ?? "")
      return [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => ({
        path: m[2].trim(),
        action: (m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "edited") as FileAction,
      }))
    }
  }
  return []
}

export function sessionFileMap(
  messages: any[],
  directory: string,
  diff: Array<{ file: string; status?: string | null; additions: number; deletions: number }>,
): FileMapEntry[] {
  const map = new Map<string, FileMapEntry & { set: Set<FileAction> }>()
  const get = (path: string, turn: number) => {
    const rel = relative(directory, path)
    const key = rel.toLowerCase()
    let e = map.get(key)
    if (!e) map.set(key, (e = { path: rel, actions: [], set: new Set(), firstTurn: turn, lastTurn: turn, additions: 0, deletions: 0, failed: false }))
    return e
  }
  let turn = 0
  for (const m of messages) {
    if (m.info?.role === "user") turn++
    for (const part of m.parts ?? []) {
      for (const t of touched(part)) {
        const e = get(isAbsolute(slash(t.path)) ? t.path : `${slash(directory)}/${t.path}`, turn)
        e.set.add(t.action)
        e.lastTurn = turn
        if (part.state?.status === "error") e.failed = true
      }
    }
  }
  for (const d of diff) {
    const e = get(isAbsolute(slash(d.file)) ? d.file : `${slash(directory)}/${d.file}`, 0)
    e.additions = d.additions ?? 0
    e.deletions = d.deletions ?? 0
    if (d.status === "added") e.set.add("created")
    else if (d.status === "deleted") e.set.add("deleted")
    else if (!e.set.has("created")) e.set.add("edited")
  }
  const order: FileAction[] = ["created", "edited", "deleted", "read"]
  return [...map.values()]
    .map(({ set, ...e }) => ({ ...e, actions: order.filter((a) => set.has(a)) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

// ------------------------------------------------------------------ project diagram

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", "coverage",
  "target", "vendor", "__pycache__", ".venv", "venv", ".gradle", ".idea", ".vscode", "bin", "obj",
])
const SOURCE = /\.(m?[jt]sx?|cjs|py|html?|css|scss|sass|less|vue|svelte|kt|kts|java|go|rs|rb|php|cs|swift|dart|c|cc|cpp|h|hpp)$/i
const RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".css", ".scss", ".py", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py"]
const MAX_FILES = 800
const MAX_READ = 300
const MAX_BYTES = 200_000

export interface DiagramNode {
  id: string
  label: string
  where: string
  folder: boolean
  files: string[]
  x: number
  y: number
}

export interface ProjectDiagram {
  nodes: DiagramNode[]
  edges: Array<{ from: string; to: string; count: number }>
  width: number
  height: number
  nodeWidth: number
  nodeHeight: number
  files: number
  truncated: boolean
}

function joinRel(base: string, rel: string) {
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
  const local = (spec: string | undefined) => {
    const s = spec?.split(/[?#]/)[0]
    if (!s || /^[a-z]+:/i.test(s) || s.startsWith("//") || s.startsWith("data:")) return
    if (s.startsWith("/")) out.push(slash(s.slice(1)))
    else if (s.startsWith(".") || /\.(html?|css|js|mjs|ts)$/i.test(s)) out.push(joinRel(dir, s))
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
        out.push(joinRel(dir, "../".repeat(up - 1) + mod.slice(up).replaceAll(".", "/")))
      } else out.push(mod.replaceAll(".", "/"))
    }
  return out
}

function componentOf(file: string, depth: number) {
  const parts = file.split("/")
  if (parts.length === 1 || depth >= parts.length) return file
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/") + "/"
}

export async function projectDiagram(directory: string): Promise<ProjectDiagram> {
  const files: string[] = []
  const queue = [""]
  let truncated = false
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift()!
    const entries = await readdir(join(directory, dir), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && path.split("/").length < 8) queue.push(path)
      } else if (e.isFile() && SOURCE.test(e.name)) files.push(path)
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
    }
  }
  const set = new Set(files)
  const resolve = (target: string) => RESOLVE_EXT.map((ext) => target + ext).find((p) => set.has(p))
  const refs = new Map<string, string[]>()
  if (files.length > MAX_READ) truncated = true
  for (const file of files.slice(0, MAX_READ)) {
    const abs = join(directory, file)
    const info = await stat(abs).catch(() => null)
    if (!info || info.size > MAX_BYTES) continue
    const buf = await readFile(abs).catch(() => null)
    if (!buf || buf.subarray(0, 8000).includes(0)) continue
    refs.set(file, references(file, buf.toString("utf8")).flatMap((t) => resolve(t) ?? []))
  }

  const tops = new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))
  const depth = files.length <= 40 ? 99 : tops.size <= 2 ? 2 : 1
  const groups = new Map<string, string[]>()
  for (const f of files) groups.set(componentOf(f, depth), [...(groups.get(componentOf(f, depth)) ?? []), f])
  const counts = new Map<string, number>()
  for (const [file, targets] of refs)
    for (const t of targets) {
      const a = componentOf(file, depth)
      const b = componentOf(t, depth)
      if (a !== b) counts.set(`${a}\n${b}`, (counts.get(`${a}\n${b}`) ?? 0) + 1)
    }
  const edges = [...counts].map(([k, count]) => {
    const [from, to] = k.split("\n")
    return { from, to, count }
  })

  // Top-down ranks: components nothing points at (entry points) first, then what they use.
  const W = 190
  const H = 58
  const out = new Map<string, string[]>([...groups.keys()].map((id) => [id, []]))
  const incoming = new Map<string, number>()
  for (const e of edges) {
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
  const ids = [...groups.keys()]
  const roots = ids.filter((id) => !incoming.get(id))
  for (const id of roots.length ? roots : ids.slice(0, 1)) visit(id, 0)
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]))
  const maxRank = Math.max(0, ...[...rank].filter(([id]) => linked.has(id)).map(([, r]) => r))
  for (const id of ids) if (!linked.has(id)) rank.set(id, linked.size ? maxRank + 1 : 0)

  const rows = new Map<number, string[]>()
  for (const id of ids) rows.set(rank.get(id) ?? 0, [...(rows.get(rank.get(id) ?? 0) ?? []), id])
  const pos = new Map<string, { x: number; y: number }>()
  let y = 30
  let width = 400
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(r)!.sort()
    for (let i = 0; i < row.length; i += 6) {
      const chunk = row.slice(i, i + 6)
      chunk.forEach((id, j) => pos.set(id, { x: 30 + j * (W + 36), y }))
      width = Math.max(width, 30 + chunk.length * (W + 36))
      y += H + 84
    }
  }

  return {
    nodes: ids.map((id) => ({
      id,
      label: id.endsWith("/") ? id.slice(0, -1) : id.split("/").pop()!,
      where: id.endsWith("/") ? "" : id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "",
      folder: id.endsWith("/"),
      files: groups.get(id)!.sort(),
      ...pos.get(id)!,
    })),
    edges,
    width,
    height: y,
    nodeWidth: W,
    nodeHeight: H,
    files: files.length,
    truncated,
  }
}
