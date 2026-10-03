import { shell } from "electron"
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { BAMBOOKIT_CONFIG } from "./config"

/**
 * Google sign-in through Firebase Auth (Firebase is the Google identity provider for BambooKit,
 * registered with Supabase as third-party auth). Desktop apps cannot host Firebase's popup flow
 * directly, so we serve a tiny page on http://localhost (an authorized Firebase domain by default)
 * that runs the official Firebase JS SDK popup and posts the resulting tokens back to this process.
 */

export interface FirebaseTokens {
  idToken: string
  refreshToken: string
  expiresIn: number
  uid: string
  email: string | null
  name: string | null
  photoUrl: string | null
}

export function isFirebaseConfigured() {
  return !!BAMBOOKIT_CONFIG.firebaseApiKey && !!BAMBOOKIT_CONFIG.firebaseProjectId
}

const SDK_VERSION = "10.14.1"

export function signInWithFirebaseGoogle(port: number): Promise<FirebaseTokens> {
  const nonce = randomBytes(24).toString("base64url")
  const authDomain = BAMBOOKIT_CONFIG.firebaseAuthDomain || `${BAMBOOKIT_CONFIG.firebaseProjectId}.firebaseapp.com`
  const config = JSON.stringify({ apiKey: BAMBOOKIT_CONFIG.firebaseApiKey, authDomain, projectId: BAMBOOKIT_CONFIG.firebaseProjectId })

  const page = `<!doctype html><html><head><meta charset="utf-8"><title>BambooKit sign-in</title>
<style>body{font-family:system-ui;background:#0b0f0c;color:#e6efe8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center}button{font:inherit;padding:10px 18px;border-radius:6px;border:1px solid #2f3a33;background:#16201a;color:#e6efe8;cursor:pointer}
.err{color:#ef8a80;margin-top:12px;white-space:pre-wrap}</style></head>
<body><div class="box"><h2>Sign in to BambooKit</h2><p id="msg">Continue with your Google account.</p>
<button id="go">Continue with Google</button><div id="err" class="err"></div></div>
<script src="https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth-compat.js"></script>
<script>
const nonce = ${JSON.stringify(nonce)};
firebase.initializeApp(${config});
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
async function finish(user) {
  const res = await fetch("/firebase-callback", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, idToken: await user.getIdToken(), refreshToken: user.refreshToken, uid: user.uid,
      email: user.email, name: user.displayName, photoUrl: user.photoURL }) });
  document.getElementById("msg").textContent = res.ok ? "Signed in. You can close this tab and return to BambooKit Desktop." : "Could not hand the session to BambooKit Desktop.";
  document.getElementById("go").remove();
}
async function go() {
  document.getElementById("err").textContent = "";
  try {
    const result = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    await finish(result.user);
  } catch (e) {
    document.getElementById("err").textContent = (e && (e.code + ": " + e.message)) || String(e);
    fetch("/firebase-callback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, error: (e && e.code) || "unknown" }) });
  }
}
document.getElementById("go").onclick = go;
</script></body></html>`

  return new Promise<FirebaseTokens>((resolve, reject) => {
    let server: Server
    const timeout = setTimeout(() => {
      server?.close()
      reject(Object.assign(new Error("Google sign-in timed out"), { code: "OAUTH_TIMEOUT" }))
    }, 5 * 60_000)
    const done = (fn: () => void) => {
      clearTimeout(timeout)
      server.close()
      fn()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`)
      if (req.method === "GET" && url.pathname === "/firebase-login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        res.end(page)
        return
      }
      if (req.method === "POST" && url.pathname === "/firebase-callback") {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          let body: any = {}
          try {
            body = JSON.parse(raw)
          } catch {}
          if (body.nonce !== nonce) {
            res.writeHead(403).end()
            return
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}")
          if (body.error) {
            done(() => reject(Object.assign(new Error(friendlyError(body.error)), { code: String(body.error) })))
            return
          }
          if (!body.idToken || !body.refreshToken) {
            done(() => reject(Object.assign(new Error("Google sign-in returned no session"), { code: "OAUTH_FAILED" })))
            return
          }
          done(() =>
            resolve({ idToken: body.idToken, refreshToken: body.refreshToken, expiresIn: 3600, uid: body.uid, email: body.email ?? null, name: body.name ?? null, photoUrl: body.photoUrl ?? null }),
          )
        })
        return
      }
      res.writeHead(404).end()
    })
    server.on("error", (err) => {
      clearTimeout(timeout)
      reject(Object.assign(new Error(`Cannot start the sign-in page: ${err.message}`), { code: "OAUTH_PORT_BUSY" }))
    })
    server.listen(port, "127.0.0.1", () => void shell.openExternal(`http://localhost:${port}/firebase-login`))
  })
}

/** Exchange a Firebase refresh token for a fresh ID token. */
export async function refreshFirebaseToken(refreshToken: string): Promise<{ idToken: string; refreshToken: string; expiresIn: number }> {
  let res: Response
  try {
    res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(BAMBOOKIT_CONFIG.firebaseApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    })
  } catch (err: any) {
    throw Object.assign(new Error(`Cannot reach Google sign-in service: ${err.message}`), { code: "NETWORK" })
  }
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `Token refresh failed (${res.status})`), { code: "invalid_grant" })
  return { idToken: body.id_token, refreshToken: body.refresh_token, expiresIn: Number(body.expires_in ?? 3600) }
}

function friendlyError(code: string) {
  switch (code) {
    case "auth/configuration-not-found":
    case "auth/operation-not-allowed":
      return "Google sign-in is not enabled in the BambooKit Firebase project (Firebase console → Authentication → Sign-in method → Google)."
    case "auth/unauthorized-domain":
      return "localhost is not an authorized domain in Firebase Authentication settings."
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled."
    default:
      return `Google sign-in failed (${code}).`
  }
}
