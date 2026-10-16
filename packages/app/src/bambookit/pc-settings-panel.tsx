import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { createSignal, For, Show } from "solid-js"
import { bambookit, bambookitApi } from "./store"
import type { BambooKitApprovalMode } from "./types"

const MODES: Array<{ value: BambooKitApprovalMode; label: string; detail: string }> = [
  { value: "ask", label: "Ask every time", detail: "Every request waits for you here or on your phone." },
  { value: "edits", label: "Auto mode", detail: "File edits are approved automatically; commands and other requests still ask." },
  { value: "all", label: "Auto-approve everything", detail: "Every request is approved automatically. Approved requests still appear in history." },
]

/** This PC's approval mode, keep-awake and developer options (shared with the phone and website). */
export function BambooKitPcSettingsPanel() {
  const api = bambookitApi()!
  const settings = () => bambookit.state()?.settings
  const [error, setError] = createSignal<string | null>(null)
  const [done, setDone] = createSignal<string | null>(null)
  const tool = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setDone(null)
    await run(fn)
    if (!error()) {
      setDone(label)
      setTimeout(() => setDone(null), 2500)
    }
  }
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    const res = await fn()
    if (!res.ok) setError(res.error ?? "Could not save the setting")
  }

  return (
    <Show when={settings()}>
      <section class="flex flex-col gap-2">
        <span class="text-11-medium uppercase tracking-wider text-text-weaker">Approvals</span>
        <div class="flex flex-col gap-1" role="radiogroup" aria-label="Approval mode">
          <For each={MODES}>
            {(mode) => (
              <button
                type="button"
                role="radio"
                aria-checked={settings()!.approvalMode === mode.value}
                class="flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left hover:bg-surface-raised-base-hover"
                classList={{
                  "border-text-strong": settings()!.approvalMode === mode.value,
                  "border-border-weak-base": settings()!.approvalMode !== mode.value,
                }}
                onClick={() => void run(() => api.setApprovalMode(mode.value))}
              >
                <span class="text-13-medium text-text-strong">{mode.label}</span>
                <span class="text-11-regular text-text-weak">{mode.detail}</span>
              </button>
            )}
          </For>
        </div>
      </section>

      <section class="flex flex-col gap-2">
        <span class="text-11-medium uppercase tracking-wider text-text-weaker">Phone</span>
        <Switch
          checked={settings()!.phoneChatAnySession !== false}
          onChange={(on) => void run(() => api.setPhoneChatAnySession(on))}
          description="Chat from your phone in any session on this computer. When off, only sessions you opened or continued here are open to your phone."
        >
          Let my phone chat in any session
        </Switch>
      </section>

      <section class="flex flex-col gap-2">
        <span class="text-11-medium uppercase tracking-wider text-text-weaker">This computer</span>
        <Switch checked={settings()!.keepAwake} onChange={(on) => void run(() => api.setKeepAwake(on))} description="Stops the computer and screen from sleeping while agents work, until you turn it off or close BambooKit.">
          ☕ Keep awake
        </Switch>
      </section>

      <section class="flex flex-col gap-2">
        <span class="text-11-medium uppercase tracking-wider text-text-weaker">Developer options</span>
        <Switch
          checked={settings()!.allowRemoteControl}
          onChange={(on) => void run(() => api.setRemoteControl(on))}
          description="Lets your phone sleep, shut down or lock this computer (after a 10-second countdown you can cancel here) and open a terminal on it. Can only be turned on here, at the computer."
        >
          Allow this computer to be controlled remotely
        </Switch>
        <div class="flex flex-wrap gap-2 pt-1">
          <Button size="small" variant="secondary" onClick={() => void tool("Copied", () => api.copyDiagnostics())}>
            Copy diagnostics
          </Button>
          <Button size="small" variant="secondary" onClick={() => void tool("Opened", () => api.openLogsFolder())}>
            Open logs folder
          </Button>
          <Button size="small" variant="secondary" onClick={() => void tool("Reconnecting", () => api.reconnect())}>
            Reconnect to BambooKit
          </Button>
          <Show when={done()}>
            <span class="text-12-regular text-text-weak self-center">{done()}</span>
          </Show>
        </div>
      </section>

      <Show when={error()}>
        <p class="text-12-regular text-text-critical-base">{error()}</p>
      </Show>
    </Show>
  )
}

/** Shown when the plan's PC limit stops this computer from connecting. BambooKit keeps retrying by itself. */
export function BambooKitPlanLimitNotice() {
  const limit = () => bambookit.state()?.planLimit
  return (
    <Show when={limit()}>
      <div class="flex flex-col gap-2 rounded-md border border-[#d9a441]/60 bg-[#d9a441]/10 px-3 py-2.5">
        <span class="text-13-medium text-text-strong">PC limit reached</span>
        <span class="text-12-regular text-text-weak">
          {limit()!.message}
          {limit()!.used !== null && limit()!.max !== null ? ` (${limit()!.used} of ${limit()!.max} in use.)` : ""} BambooKit connects by itself once you upgrade
          or remove another computer.
        </span>
        <Show when={limit()!.upgradeUrl}>
          <a class="text-12-medium text-text-strong underline underline-offset-2" href={limit()!.upgradeUrl!} target="_blank" rel="noopener noreferrer">
            Upgrade to Pro
          </a>
        </Show>
      </div>
    </Show>
  )
}
