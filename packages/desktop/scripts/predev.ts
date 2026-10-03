import { $ } from "bun"
import { downloadCliToResources, windowsify } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// BambooKit: stamp the engine with its upstream OpenCode version (not a 0.0.0-<branch> preview
// version) so OpenCode services that gate features by version, e.g. the free model tier, accept it.
const engineVersion = process.env.OPENCODE_VERSION ?? (await Bun.file("../opencode/package.json").json()).version
await $`cd ../opencode && bun script/build-node.ts`.env({ ...process.env, OPENCODE_VERSION: engineVersion })
// BambooKit: reuse an existing official CLI binary (the npm download is unreliable on some Windows setups).
if (!(await Bun.file(windowsify("resources/opencode-cli")).exists())) await downloadCliToResources()
