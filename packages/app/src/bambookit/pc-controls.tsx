import { Button } from "@opencode-ai/ui/button"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { bambookit, bambookitApi } from "./store"

/** A coffee cup; filled with steam while this computer is kept awake. */
function CoffeeIcon(props: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z" fill={props.on ? "currentColor" : "none"} />
      <path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16" />
      <Show when={props.on}>
        <path d="M8 2.5c-.6.8-.6 1.7 0 2.5M12 2.5c-.6.8-.6 1.7 0 2.5" />
      </Show>
    </svg>
  )
}

/**
 * ☕ Keep awake: stops this computer and its screen from sleeping while agents work, until it is clicked
 * again or the app closes. Phones and the website can switch it too (SET_KEEP_AWAKE).
 */
export function BambooKitKeepAwakeButton() {
  const api = bambookitApi()
  const on = () => !!bambookit.state()?.settings?.keepAwake
  const [busy, setBusy] = createSignal(false)
  const toggle = async () => {
    if (!api || busy()) return
    setBusy(true)
    await api.setKeepAwake(!on())
    setBusy(false)
  }
  return (
    <Show when={api && bambookit.state()?.settings}>
      <button
        type="button"
        aria-pressed={on()}
        title={on() ? "Keeping this computer awake — click to let it sleep normally" : "Keep this computer awake while agents work"}
        class="flex items-center justify-center size-6 rounded-md hover:bg-surface-raised-base-hover [-webkit-app-region:no-drag]"
        classList={{ "text-[#d9a441]": on(), "text-text-weak": !on() }}
        disabled={busy()}
        onClick={() => void toggle()}
      >
        <CoffeeIcon on={on()} />
      </button>
    </Show>
  )
}

/**
 * Links sessions on this PC with the phone: opening a session here lets the phone chat in it, and a phone's
 * "Continue on PC" opens that session here. Renders nothing; lives in the titlebar, inside the router.
 */
export function BambooKitSessionLink() {
  const api = bambookitApi()
  if (!api) return null
  const params = useParams()
  const navigate = useNavigate()
  createEffect(() => {
    const id = params.id
    if (id) void api.sessionOpened(id)
  })
  const off = api.onEvent((event) => {
    if (event.type !== "open-session" || typeof event.sessionId !== "string" || typeof event.directory !== "string") return
    navigate(`/${base64Encode(event.directory)}/session/${event.sessionId}`)
  })
  onCleanup(off)
  return null
}

const ACTION_LABEL = { sleep: "Sleeping", shutdown: "Shutting down", lock: "Locking" } as const

/** Full-window countdown for a power action requested from a phone; the person at the computer can cancel it. */
export function BambooKitPowerCountdown() {
  const api = bambookitApi()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 250)
  onCleanup(() => clearInterval(timer))
  const pending = () => bambookit.state()?.pendingPower ?? null
  const seconds = () => Math.max(0, Math.ceil(((pending()?.runsAt ?? 0) - now()) / 1000))

  return (
    <Show when={api && pending()}>
      <Portal>
        <div class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70" role="alertdialog" aria-live="assertive">
          <div class="flex flex-col items-center gap-4 rounded-xl border border-border-weak-base bg-background-base px-10 py-8 text-center shadow-lg">
            <span class="text-11-medium uppercase tracking-wider text-text-weaker">Requested from your phone</span>
            <span class="text-20-medium text-text-strong">
              {ACTION_LABEL[pending()!.action]} this computer in {seconds()}s
            </span>
            <span class="text-13-regular text-text-weak max-w-[340px]">Save your work, or cancel if you did not ask for this.</span>
            <Button size="large" variant="primary" onClick={() => void api!.cancelPower()}>
              Cancel
            </Button>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
