import { createRoot, createSignal } from "solid-js"
import type { BambooKitBridgeAPI, BambooKitState } from "./types"

export function bambookitApi(): BambooKitBridgeAPI | undefined {
  return typeof window === "undefined" ? undefined : (window.api as { bambookit?: BambooKitBridgeAPI } | undefined)?.bambookit
}

const SKIP_KEY = "bambookit.login.skipped"

/** Shared, app-wide BambooKit state mirrored from the desktop main process. */
export const bambookit = createRoot(() => {
  const [state, setState] = createSignal<BambooKitState | null>(null)
  const [skipped, setSkippedSignal] = createSignal(readSkipped())
  const api = bambookitApi()

  if (api) {
    void api.getState().then((res) => res.ok && setState(res.data))
    api.onState(setState)
  }

  return {
    available: !!api,
    state,
    skipped,
    setSkipped(value: boolean) {
      try {
        if (value) localStorage.setItem(SKIP_KEY, "1")
        else localStorage.removeItem(SKIP_KEY)
      } catch {}
      setSkippedSignal(value)
    },
  }
})

function readSkipped() {
  try {
    return localStorage.getItem(SKIP_KEY) === "1"
  } catch {
    return false
  }
}
