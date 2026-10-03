#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, windowsify, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// BambooKit: stamp the engine with its upstream OpenCode version (not a 0.0.0-<branch> preview
// version) so OpenCode services that gate features by version, e.g. the free model tier, accept it.
const engineVersion = process.env.OPENCODE_VERSION ?? (await Bun.file("../opencode/package.json").json()).version
await $`cd ../opencode && bun script/build-node.ts`.env({ ...process.env, OPENCODE_VERSION: engineVersion })
// BambooKit: reuse an existing official CLI binary (the npm download is unreliable on some Windows setups).
if (channel === "dev" && !(await Bun.file(windowsify("resources/opencode-cli")).exists())) await downloadCliToResources()
