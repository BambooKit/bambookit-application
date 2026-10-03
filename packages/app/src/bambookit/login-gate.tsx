import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, Match, Show, Switch, type ParentProps } from "solid-js"
import { Mark } from "@opencode-ai/ui/logo"
import { bambookit, bambookitApi } from "./store"

type Mode = "signin" | "signup" | "reset"

/**
 * Shows the BambooKit account screen before the OpenCode workspace when the desktop build has
 * BambooKit configured and nobody is signed in. Users can always continue offline: local OpenCode
 * never depends on BambooKit cloud connectivity.
 */
export function BambooKitLoginGate(props: ParentProps) {
  const needsLogin = () => {
    const s = bambookit.state()
    return bambookit.available && !!s?.configured && !s.account && !bambookit.skipped()
  }
  return (
    <Show when={needsLogin()} fallback={props.children}>
      <BambooKitLoginScreen onSkip={() => bambookit.setSkipped(true)} />
    </Show>
  )
}

export function BambooKitLoginScreen(props: { onSkip?: () => void; onDone?: () => void }) {
  const api = bambookitApi()!
  const [mode, setMode] = createSignal<Mode>("signin")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; data?: any }>, onOk?: (data: any) => void) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong")
      else onOk?.(res.data)
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: Event) => {
    e.preventDefault()
    if (mode() === "signin") void run(() => api.signIn(email(), password()), () => (bambookit.setSkipped(false), props.onDone?.()))
    else if (mode() === "signup")
      void run(
        () => api.signUp(email(), password(), name() || undefined),
        (data) => {
          if (data?.confirmationRequired) {
            setMode("signin")
            setNotice(`Check ${email()} to confirm your account, then sign in.`)
          } else {
            bambookit.setSkipped(false)
            props.onDone?.()
          }
        },
      )
    else void run(() => api.resetPassword(email()), () => setNotice(`If an account exists for ${email()}, a reset link is on its way.`))
  }

  return (
    <div class="h-dvh w-screen flex items-center justify-center bg-background-base p-6" data-component="bambookit-login">
      <div class="w-full max-w-[380px] flex flex-col gap-6">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <Mark class="w-5 h-6" />
            <span class="text-16-medium text-text-strong tracking-wide">BambooKit</span>
          </div>
          <span class="text-13-regular text-text-weak">
            <Switch>
              <Match when={mode() === "signin"}>Sign in to connect this PC with your phone and the BambooKit control plane.</Match>
              <Match when={mode() === "signup"}>Create a BambooKit account.</Match>
              <Match when={mode() === "reset"}>Reset your password.</Match>
            </Switch>
          </span>
        </div>

        <Show when={mode() !== "reset"}>
          <Button variant="secondary" size="large" disabled={busy()} onClick={() => void run(() => api.signInWithGoogle(), () => (bambookit.setSkipped(false), props.onDone?.()))}>
            Continue with Google
          </Button>
          <div class="flex items-center gap-3 text-11-regular text-text-weaker">
            <div class="h-px flex-1 bg-border-weak-base" />
            or
            <div class="h-px flex-1 bg-border-weak-base" />
          </div>
        </Show>

        <form class="flex flex-col gap-3" onSubmit={submit}>
          <Show when={mode() === "signup"}>
            <TextField type="text" label="Name" placeholder="Optional" value={name()} onChange={setName} />
          </Show>
          <TextField autofocus type="email" label="Email" placeholder="you@example.com" value={email()} onChange={setEmail} />
          <Show when={mode() !== "reset"}>
            <TextField type="password" label="Password" value={password()} onChange={setPassword} />
          </Show>

          <Show when={error()}>
            <p class="text-12-regular text-text-critical-base" role="alert">{error()}</p>
          </Show>
          <Show when={notice()}>
            <p class="text-12-regular text-text-base" role="status">{notice()}</p>
          </Show>

          <Button type="submit" variant="primary" size="large" disabled={busy() || !email() || (mode() !== "reset" && !password())}>
            {busy() ? "Please wait…" : mode() === "signin" ? "Sign in" : mode() === "signup" ? "Create account" : "Send reset link"}
          </Button>
        </form>

        <div class="flex items-center justify-between text-12-regular">
          <Switch>
            <Match when={mode() === "signin"}>
              <button type="button" class="text-text-interactive-base hover:underline" onClick={() => setMode("signup")}>Create account</button>
              <button type="button" class="text-text-weak hover:text-text-base" onClick={() => setMode("reset")}>Forgot password?</button>
            </Match>
            <Match when={mode() !== "signin"}>
              <button type="button" class="text-text-interactive-base hover:underline" onClick={() => setMode("signin")}>Back to sign in</button>
              <Show when={mode() === "signup" && email()}>
                <button type="button" class="text-text-weak hover:text-text-base" onClick={() => void run(() => api.resendConfirmation(email()), () => setNotice("Confirmation email sent."))}>
                  Resend confirmation
                </button>
              </Show>
            </Match>
          </Switch>
        </div>

        <Show when={props.onSkip}>
          <button type="button" class="text-12-regular text-text-weaker hover:text-text-weak text-left" onClick={() => props.onSkip?.()}>
            Continue offline — local agent only, no remote control
          </button>
        </Show>
      </div>
    </div>
  )
}
