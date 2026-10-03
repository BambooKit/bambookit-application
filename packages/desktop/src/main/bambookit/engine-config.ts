/**
 * OpenCode configuration that BambooKit Desktop layers on top of the user's own config, using
 * OpenCode's supported OPENCODE_CONFIG_CONTENT mechanism (no engine patches, no edits to the
 * user's ~/.config/opencode files).
 *
 * - The OpenCode-hosted free/Zen models are shown under the BambooKit name. The provider id stays
 *   "opencode", so authentication, billing and routing are unchanged.
 * - Models that OpenCode Zen currently lists but cannot serve are hidden, so users are not offered a
 *   model that always fails. Each entry was verified against stock upstream OpenCode; remove an entry
 *   once Zen serves the model again (re-test with `scripts/test-free-models.ps1`).
 */
export const UNAVAILABLE_ZEN_MODELS = [
  // 2026-10-02: Zen returns "Not Found: Cannot find any route matching [POST]
  // https://opencode.ai/zen/v1/chat/completions" for this model, also on stock OpenCode 1.18.32.
  "ling-3.0-flash-fin-free",
]

export function bambookitEngineConfig(apiUrl?: string) {
  return {
    // "Publish on web" shares sessions through the BambooKit API instead of a third-party share service.
    ...(apiUrl ? { enterprise: { url: apiUrl } } : {}),
    provider: {
      opencode: {
        name: "BambooKit",
        blacklist: UNAVAILABLE_ZEN_MODELS,
      },
    },
  }
}

/** Merge BambooKit's layer into OPENCODE_CONFIG_CONTENT (keeping anything the user already set there). */
export function applyBambooKitEngineConfig(apiUrl?: string, env: NodeJS.ProcessEnv = process.env) {
  let existing: Record<string, any> = {}
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      existing = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    } catch {
      // Not JSON (e.g. JSONC); leave the user's value untouched rather than corrupting it.
      return
    }
  }
  const ours = bambookitEngineConfig(apiUrl)
  const userOpencode = existing.provider?.opencode ?? {}
  const merged = {
    ...existing,
    ...(existing.enterprise ?? ours.enterprise ? { enterprise: existing.enterprise ?? ours.enterprise } : {}),
    provider: {
      ...(existing.provider ?? {}),
      opencode: {
        ...ours.provider.opencode,
        ...userOpencode,
        blacklist: [...new Set([...(ours.provider.opencode.blacklist ?? []), ...(userOpencode.blacklist ?? [])])],
      },
    },
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(merged)
}
