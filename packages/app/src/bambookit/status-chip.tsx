import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show } from "solid-js"
import { DialogBambooKitDevices, StatusDot } from "./devices-dialog"
import { bambookit } from "./store"

/** Compact BambooKit status in the titlebar. Opens the BambooKit device/account dialog. */
export function BambooKitStatusChip() {
  const dialog = useDialog()
  const openDevices = () => dialog.show(() => <DialogBambooKitDevices />)
  const state = () => bambookit.state()
  const linkState = () => {
    const s = state()
    if (!s?.account) return "disabled" as const
    if (s.api === "error" || s.realtime === "error") return "error" as const
    if (s.realtime === "connected") return "connected" as const
    if (s.api === "connecting" || s.realtime === "connecting") return "connecting" as const
    return "offline" as const
  }
  const label = () => {
    const s = state()
    if (!s?.configured) return "BambooKit not configured"
    if (!s.account) return "Sign in to BambooKit"
    if (s.planLimit) return "BambooKit · PC limit reached"
    if (linkState() === "connected") return s.pairedPhones ? `BambooKit · ${s.pairedPhones} phone${s.pairedPhones === 1 ? "" : "s"}` : "BambooKit"
    return `BambooKit · ${linkState() === "connecting" ? "connecting" : linkState() === "error" ? "error" : "offline"}`
  }

  return (
    <Show when={bambookit.available}>
      <button
        type="button"
        class="flex items-center gap-1.5 h-6 px-2 rounded-md text-11-medium text-text-base hover:bg-surface-raised-base-hover [-webkit-app-region:no-drag]"
        title={state()?.account?.email ?? "BambooKit"}
        onClick={openDevices}
      >
        <StatusDot state={linkState()} />
        <span class="truncate max-w-[200px]">{label()}</span>
      </button>
    </Show>
  )
}
