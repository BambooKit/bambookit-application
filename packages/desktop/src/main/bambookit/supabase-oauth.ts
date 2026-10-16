import { shell } from "electron"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { BAMBOOKIT_CONFIG } from "./config"

/**
 * Google sign-in through Supabase Auth (the same account system BambooKit Web, Android and email sign-in use).
 *
 * PKCE flow: the browser goes to Supabase's /authorize and Google signs the user in. Supabase only redirects to
 * addresses it trusts, which always include the BambooKit website, so it returns to the site's /desktop-callback page,
 * which forwards the one-time code to a one-shot listener on this PC (http://localhost:<port>/auth/callback). The code
 * is exchanged for a session with the PKCE verifier, which never leaves this process.
 */

const WEB_URL = "https://bambookit-web.onrender.com"

let cancelPending: (() => void) | null = null

/** Stops a Google sign-in that is waiting for the browser (the user closed the tab or changed their mind). */
export function cancelSupabaseGoogle() {
  cancelPending?.()
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>BambooKit sign-in</title>
<style>body{font-family:system-ui;background:#121212;color:#ededed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center}p{color:#a0a0a0}</style></head>
<body><div class="box"><h2>${title}</h2><p>${body}</p></div></body></html>`

export function signInWithSupabaseGoogle(port: number): Promise<{ authCode: string; codeVerifier: string }> {
  const codeVerifier = randomBytes(48).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const redirectTo = `${process.env.BAMBOOKIT_WEB_URL || WEB_URL}/desktop-callback/?port=${port}`
  const authorize = new URL(`${BAMBOOKIT_CONFIG.supabaseUrl}/auth/v1/authorize`)
  authorize.searchParams.set("provider", "google")
  authorize.searchParams.set("redirect_to", redirectTo)
  authorize.searchParams.set("code_challenge", codeChallenge)
  authorize.searchParams.set("code_challenge_method", "s256")

  cancelPending?.()
  return new Promise((resolve, reject) => {
    let server: Server
    const timeout = setTimeout(() => {
      cancelPending = null
      server?.close()
      reject(Object.assign(new Error("Google sign-in did not finish in the browser. Try again."), { code: "OAUTH_TIMEOUT" }))
    }, 5 * 60_000)
    cancelPending = () => {
      cancelPending = null
      clearTimeout(timeout)
      server?.close()
      reject(Object.assign(new Error("Google sign-in was cancelled."), { code: "OAUTH_CANCELLED" }))
    }
    const done = (fn: () => void) => {
      cancelPending = null
      clearTimeout(timeout)
      // Let the browser finish loading the result page before the server goes away.
      setTimeout(() => server.close(), 500)
      fn()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`)
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error_description") || url.searchParams.get("error")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      if (!code) {
        res.end(page("Sign-in failed", error ? escapeHtml(error) : "No authorization code was returned."))
        done(() => reject(Object.assign(new Error(error ? `Google sign-in failed: ${error}` : "Google sign-in returned no code"), { code: "OAUTH_FAILED" })))
        return
      }
      res.end(page("Signed in", "You can close this tab and return to BambooKit."))
      done(() => resolve({ authCode: code, codeVerifier }))
    })
    server.on("error", (err) => {
      clearTimeout(timeout)
      reject(Object.assign(new Error(`Cannot start the sign-in callback: ${err.message}`), { code: "OAUTH_PORT_BUSY" }))
    })
    server.listen(port, "127.0.0.1", () => void shell.openExternal(authorize.toString()))
  })
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
