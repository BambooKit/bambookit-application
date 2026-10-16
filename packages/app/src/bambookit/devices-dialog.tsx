import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import QRCode from "qrcode"
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { bambookit, bambookitApi } from "./store"
import { BambooKitLoginScreen } from "./login-gate"
import { BambooKitPcSettingsPanel, BambooKitPlanLimitNotice } from "./pc-settings-panel"
import { BambooKitProfilePanel } from "./profile-panel"
import type { BambooKitLinkState } from "./types"

const LABEL: Record<BambooKitLinkState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Offline",
  error: "Error",
  disabled: "Not connected",
}

export function StatusDot(props: { state: BambooKitLinkState | undefined }) {
  return (
    <span
      class="inline-block size-2 rounded-full shrink-0"
      classList={{
        "bg-[#4caf50]": props.state === "connected",
        "bg-[#e0a33a] animate-pulse": props.state === "connecting",
        "bg-[#d9534f]": props.state === "error",
        "bg-text-weaker": props.state === "offline" || props.state === "disabled" || !props.state,
      }}
    />
  )
}

function Row(props: { label: string; state?: BambooKitLinkState; value?: string }) {
  return (
    <div class="flex items-center justify-between py-1.5 text-13-regular">
      <span class="text-text-weak">{props.label}</span>
      <span class="flex items-center gap-2 text-text-strong">
        <Show when={props.state}>
          <StatusDot state={props.state} />
        </Show>
        {props.value ?? (props.state ? LABEL[props.state] : "")}
      </span>
    </div>
  )
}

export function DialogBambooKitDevices() {
  const api = bambookitApi()!
  const [view, setView] = createSignal<"overview" | "pair" | "profile">("overview")
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [devices, { refetch }] = createResource(async () => {
    if (!bambookit.state()?.device) return []
    const res = await api.listDevices()
    if (!res.ok) throw new Error(res.error)
    return res.data
  })

  const phones = () => {
    const me = bambookit.state()?.device?.id
    const self = devices()?.find((d) => d.id === me)
    const linked = new Set(self?.linkedDevices.map((l) => l.id) ?? [])
    return (devices() ?? []).filter((d) => d.kind === "mobile" && linked.has(d.id))
  }

  const off = api.onEvent((event) => {
    if (event.type === "pairing.completed") {
      setView("overview")
      void refetch()
    }
  })
  onCleanup(off)

  return (
    <Dialog title="BambooKit" class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-5 p-6 pt-0 max-h-[78vh] overflow-y-auto">
        <Show when={bambookit.state()?.account} fallback={<BambooKitLoginScreenInline />}>
          <Show
            when={view() === "overview"}
            fallback={view() === "profile" ? <BambooKitProfilePanel onBack={() => setView("overview")} /> : <PairPanel onBack={() => setView("overview")} />}
          >
            <section class="flex flex-col">
              <span class="text-11-medium uppercase tracking-wider text-text-weaker pb-1">This device</span>
              <Row label="Device" value={bambookit.state()?.device?.name ?? "Registering…"} />
              <Row label="Account" value={bambookit.state()?.account?.email ?? ""} />
              <Row label="BambooKit API" state={bambookit.state()?.api} />
              <Row label="Realtime" state={bambookit.state()?.realtime} />
              <Row label="Agent engine" state={bambookit.state()?.opencode} />
              <Show when={bambookit.state()?.error && !bambookit.state()?.planLimit}>
                <p class="text-12-regular text-text-critical-base pt-1 break-words">{bambookit.state()?.error}</p>
              </Show>
            </section>

            <BambooKitPlanLimitNotice />
            <BambooKitPcSettingsPanel />

            <section class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <span class="text-11-medium uppercase tracking-wider text-text-weaker">Paired phones</span>
                <Button size="small" variant="primary" disabled={!bambookit.state()?.device || bambookit.state()?.api !== "connected"} onClick={() => setView("pair")}>
                  Add mobile device
                </Button>
              </div>
              <Show when={!devices.error} fallback={<p class="text-12-regular text-text-critical-base">{String(devices.error?.message ?? devices.error)}</p>}>
                <Show when={phones().length} fallback={<p class="text-12-regular text-text-weak">No phones paired yet.</p>}>
                  <For each={phones()}>
                    {(phone) => (
                      <div class="flex items-center justify-between rounded-md border border-border-weak-base px-3 py-2">
                        <div class="flex items-center gap-2 min-w-0">
                          <StatusDot state={phone.online ? "connected" : "offline"} />
                          <div class="flex flex-col min-w-0">
                            <span class="text-13-medium text-text-strong truncate">{phone.name}</span>
                            <span class="text-11-regular text-text-weak">
                              {phone.platform}
                              {phone.lastSeenAt ? ` · seen ${new Date(phone.lastSeenAt).toLocaleString()}` : ""}
                            </span>
                          </div>
                        </div>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={async () => {
                            setActionError(null)
                            const res = await api.unlinkDevice(phone.id)
                            if (!res.ok) setActionError(res.error)
                            void refetch()
                          }}
                        >
                          Disconnect
                        </Button>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={actionError()}>
                <p class="text-12-regular text-text-critical-base">{actionError()}</p>
              </Show>
            </section>

            <div class="flex justify-between">
              <Button size="small" variant="secondary" disabled={bambookit.state()?.api !== "connected"} onClick={() => setView("profile")}>
                Profile & plan
              </Button>
              <Button size="small" variant="ghost" onClick={() => void api.signOut()}>
                Sign out of BambooKit
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

function BambooKitLoginScreenInline() {
  const dialog = useDialog()
  return (
    <div class="-m-6 [&_[data-component=bambookit-login]]:h-auto [&_[data-component=bambookit-login]]:w-full [&_[data-component=bambookit-login]]:py-2">
      <BambooKitLoginScreen onDone={() => dialog.close()} />
    </div>
  )
}

/** Shows a short-lived, single-use pairing QR. The QR only contains the one-time token URI. */
function PairPanel(props: { onBack: () => void }) {
  const api = bambookitApi()!
  const [qr, setQr] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [remaining, setRemaining] = createSignal(0)
  let expiresAt = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const generate = async () => {
    setError(null)
    const res = await api.createPairing()
    if (!res.ok) {
      setQr(null)
      setError(res.error)
      return
    }
    expiresAt = Date.parse(res.data.expiresAt)
    setQr(await QRCode.toDataURL(res.data.uri, { margin: 4, width: 280, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }))
    setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)))
  }

  onMount(() => {
    void generate()
    timer = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      setRemaining(left)
      // Rotate automatically so the code on screen is always valid.
      if (expiresAt && left === 0) void generate()
    }, 1000)
  })
  onCleanup(() => clearInterval(timer))

  return (
    <section class="flex flex-col items-center gap-4">
      <div class="flex flex-col items-center gap-1 text-center">
        <span class="text-14-medium text-text-strong">Connect mobile device</span>
        <span class="text-12-regular text-text-weak">Open BambooKit on your phone → Devices → Add device, then scan this code.</span>
      </div>
      <div class="size-[296px] rounded-lg bg-white flex items-center justify-center">
        <Show when={qr()} fallback={<span class="text-12-regular text-[#666]">{error() ? "Unavailable" : "Generating…"}</span>}>
          <img src={qr()!} alt="BambooKit pairing QR code" class="size-[280px] rounded-md" style={{ "image-rendering": "pixelated" }} />
        </Show>
      </div>
      <Show when={error()} fallback={<span class="text-12-regular text-text-weak">Single-use code · refreshes in {remaining()}s</span>}>
        <span class="text-12-regular text-text-critical-base text-center">{error()}</span>
      </Show>
      <div class="flex gap-2">
        <Button size="small" variant="ghost" onClick={props.onBack}>Back</Button>
        <Button size="small" variant="secondary" onClick={() => void generate()}>New code</Button>
      </div>
    </section>
  )
}
