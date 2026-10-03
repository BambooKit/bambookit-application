import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

// BambooKit build configuration: environment variables win over packages/desktop/.env.bambookit
// (an empty variable counts as unset, so it can never blank out the hosted API URL).
const bambookitEnv = (() => {
  const file: Record<string, string> = {}
  if (existsSync(".env.bambookit")) {
    for (const line of readFileSync(".env.bambookit", "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) file[m[1]] = m[2]
    }
  }
  const keys = [
    "BAMBOOKIT_API_URL",
    "BAMBOOKIT_SUPABASE_URL",
    "BAMBOOKIT_SUPABASE_ANON_KEY",
    "BAMBOOKIT_FIREBASE_API_KEY",
    "BAMBOOKIT_FIREBASE_PROJECT_ID",
    "BAMBOOKIT_FIREBASE_AUTH_DOMAIN",
  ]
  return Object.fromEntries(keys.map((k) => [`import.meta.env.${k}`, JSON.stringify(process.env[k]?.trim() || file[k]?.trim() || "")]))
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      ...bambookitEnv,
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    // BambooKit: pre-bundle the markdown/highlighting dependencies of the lazily loaded message renderer
    // at dev startup. Otherwise Vite discovers them on the first AI reply, re-optimizes and force-reloads
    // the window (a blank screen for several seconds). They belong to workspace packages, hence ">".
    optimizeDeps: {
      include: [
        "@opencode-ai/app > @opencode-ai/ui > @shikijs/stream",
        "@opencode-ai/app > @opencode-ai/ui > marked",
        "@opencode-ai/app > @opencode-ai/ui > remend",
        "@opencode-ai/app > @opencode-ai/ui > katex",
        "@opencode-ai/app > @opencode-ai/ui > marked-shiki",
      ],
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
