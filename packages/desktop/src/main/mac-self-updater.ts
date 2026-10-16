import { app } from "electron"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { access, constants, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { UpdaterBackend } from "./updater-controller"

/**
 * macOS updates without Squirrel.Mac. Squirrel only installs an update signed with the same Apple Developer ID as
 * the running app, which ad-hoc signed BambooKit builds cannot satisfy. Instead: electron-updater still reads
 * latest-mac.yml from GitHub Releases (check only), then this downloads the zip for this Mac's architecture,
 * verifies its SHA-512 from latest-mac.yml, and swaps the app bundle after BambooKit quits.
 */

interface UpdateFile {
  url: string
  sha512: string
  size?: number
}

interface CheckResult {
  isUpdateAvailable?: boolean
  updateInfo?: { version?: string; files?: UpdateFile[] }
}

const RELEASES = "https://github.com/BambooKit/bambookit-mac/releases/download"

function run(command: string, args: string[]) {
  return new Promise<void>((resolveRun, reject) =>
    execFile(command, args, { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(`${command} failed: ${stderr || err.message}`)) : resolveRun())),
  )
}

/** /Applications/BambooKit.app for /Applications/BambooKit.app/Contents/MacOS/BambooKit. */
function currentBundle() {
  return resolve(dirname(app.getPath("exe")), "..", "..")
}

export function createMacSelfUpdaterBackend(check: () => Promise<CheckResult | null | undefined>, log: (message: string, data?: unknown) => void): UpdaterBackend {
  let latest: CheckResult["updateInfo"] | null = null
  let staged: string | null = null

  return {
    async checkForUpdates() {
      const result = await check()
      latest = result?.updateInfo ?? null
      return result
    },

    async downloadUpdate() {
      const version = latest?.version
      const file = latest?.files?.find((f) => f.url.endsWith(`-mac-${process.arch}.zip`))
      if (!version || !file) throw new Error(`The release has no ${process.arch} update for this Mac`)
      const url = /^https?:\/\//.test(file.url) ? file.url : `${RELEASES}/v${version}/${encodeURIComponent(file.url)}`

      const dir = await mkdtemp(join(tmpdir(), "bambookit-update-"))
      const zip = join(dir, "update.zip")
      log("mac update download", { version, url })
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`Update download failed (HTTP ${res.status})`)
      const hash = createHash("sha512")
      await pipeline(
        Readable.fromWeb(res.body as any),
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(zip),
      )
      // latest-mac.yml records the zip's SHA-512 (base64); refuse anything else.
      if (hash.digest("base64") !== file.sha512) {
        await rm(dir, { recursive: true, force: true })
        throw new Error("The downloaded update does not match the release checksum")
      }

      const out = join(dir, "app")
      await mkdir(out)
      await run("/usr/bin/ditto", ["-x", "-k", zip, out])
      const bundle = (await readdir(out)).find((name) => name.endsWith(".app"))
      if (!bundle) throw new Error("The update does not contain an app")
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(out, bundle)])
      await rm(zip, { force: true })
      staged = join(out, bundle)
      log("mac update staged", { version, staged })
    },

    quitAndInstall() {
      if (!staged) throw new Error("No update has been downloaded")
      const target = currentBundle()
      if (!target.endsWith(".app")) throw new Error("BambooKit is not running from an app bundle")
      const script = join(dirname(staged), "install.sh")
      // Wait for this process to exit, replace the bundle, clear the download quarantine and reopen BambooKit.
      const body = [
        "#!/bin/sh",
        `pid=${process.pid}`,
        'while kill -0 "$pid" 2>/dev/null; do sleep 0.3; done',
        `old=${shellQuote(target)}`,
        `new=${shellQuote(staged)}`,
        'backup="$old.previous"',
        'rm -rf "$backup"',
        'mv "$old" "$backup" || exit 1',
        'if /usr/bin/ditto "$new" "$old"; then rm -rf "$backup"; else rm -rf "$old"; mv "$backup" "$old"; fi',
        '/usr/bin/xattr -dr com.apple.quarantine "$old" 2>/dev/null',
        '/usr/bin/open "$old"',
        `rm -rf ${shellQuote(dirname(dirname(staged)))}`,
        "",
      ].join("\n")
      return installAfterQuit(script, body, target)
    },
  }
}

async function ensureWritable(path: string) {
  try {
    await access(dirname(path), constants.W_OK)
  } catch {
    throw new Error(`BambooKit cannot replace itself in ${dirname(path)}. Run the installer again: curl -fsSL https://bambookit-web.onrender.com/install.sh | bash`)
  }
}

function installAfterQuit(script: string, body: string, target: string) {
  // The controller expects quitAndInstall to be synchronous; do the checks and handoff, then quit.
  void (async () => {
    await ensureWritable(target)
    await writeFile(script, body, { mode: 0o755 })
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref()
    app.quit()
  })().catch((err) => {
    // Surface the reason in the log; the app keeps running and the next check offers the update again.
    console.error("[bambookit] update install failed:", err?.message ?? err)
  })
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
