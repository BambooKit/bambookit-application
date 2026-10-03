import { BAMBOOKIT_CONFIG, isAuthConfigured } from "./config"
import { deleteSecret, readSecret, writeSecret } from "./secure-store"
import { isFirebaseConfigured, refreshFirebaseToken, signInWithFirebaseGoogle } from "./firebase"

export interface AuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
  /** Who issued the access token: Supabase Auth (email/password) or Firebase (Google). */
  issuer?: "supabase" | "firebase"
  user: { id: string; email: string | null; name: string | null; avatarUrl: string | null; provider: string | null }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

type Listener = (session: AuthSession | null) => void

/**
 * Supabase Auth over its REST API (GoTrue). The same Supabase project is used by BambooKit Web
 * and Android, so one account works everywhere. Tokens are persisted encrypted (safeStorage).
 */
export class SupabaseAuth {
  private session: AuthSession | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private listeners = new Set<Listener>()
  private refreshing: Promise<AuthSession | null> | null = null
  private lastIssuer: AuthSession["issuer"]
  /** Called with the reason when the session is dropped because the server rejected it. */
  onSignedOut?: (reason: string) => void

  get current(): AuthSession | null {
    return this.session
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async restore(): Promise<AuthSession | null> {
    const stored = await readSecret<AuthSession>("auth-session")
    if (!stored) return null
    this.session = stored
    if (stored.expiresAt - Date.now() < 120_000) {
      // Expired or about to: try to refresh. Keep the session on network errors (offline start).
      await this.refresh().catch(() => undefined)
    } else {
      this.schedule()
    }
    return this.session
  }

  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    const body = await this.request("/token?grant_type=password", { email: email.trim(), password })
    return this.accept(body)
  }

  /** Returns a session, or null when the project requires email confirmation first. */
  async signUp(email: string, password: string, name?: string): Promise<AuthSession | null> {
    const body = await this.request("/signup", { email: email.trim(), password, data: name ? { full_name: name } : undefined })
    if (!body.access_token) return null
    return this.accept(body)
  }

  async resendConfirmation(email: string): Promise<void> {
    await this.request("/resend", { type: "signup", email: email.trim() })
  }

  async sendPasswordReset(email: string): Promise<void> {
    await this.request("/recover", { email: email.trim() })
  }

  /** Google sign-in via Firebase Auth (Firebase is registered with Supabase as third-party auth). */
  async signInWithGoogle(): Promise<AuthSession> {
    if (!isFirebaseConfigured()) {
      throw new AuthError("Google sign-in is not configured in this build (missing Firebase API key / project id).", "AUTH_NOT_CONFIGURED")
    }
    let tokens
    try {
      tokens = await signInWithFirebaseGoogle(BAMBOOKIT_CONFIG.oauthCallbackPort)
    } catch (err: any) {
      throw new AuthError(err?.message ?? String(err), err?.code ?? "OAUTH_FAILED")
    }
    const session: AuthSession = {
      accessToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      issuer: "firebase",
      user: { id: tokens.uid, email: tokens.email, name: tokens.name, avatarUrl: tokens.photoUrl, provider: "google" },
    }
    await this.store(session)
    return session
  }

  async signOut(): Promise<void> {
    const token = this.session?.accessToken
    this.lastIssuer = this.session?.issuer
    this.clearTimer()
    this.session = null
    await deleteSecret("auth-session")
    this.emit()
    if (token && this.lastIssuer !== "firebase") {
      await fetch(`${BAMBOOKIT_CONFIG.supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: BAMBOOKIT_CONFIG.supabaseAnonKey, Authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }
  }

  /** A valid access token, refreshing first if it is close to expiry. */
  async accessToken(): Promise<string> {
    if (!this.session) throw new AuthError("Not signed in", "NOT_SIGNED_IN")
    if (this.session.expiresAt - Date.now() < 60_000) await this.refresh()
    if (!this.session) throw new AuthError("Session expired. Sign in again.", "NOT_SIGNED_IN")
    return this.session.accessToken
  }

  refresh(): Promise<AuthSession | null> {
    if (this.refreshing) return this.refreshing
    const current = this.session
    if (!current) return Promise.resolve(null)
    const next =
      current.issuer === "firebase"
        ? refreshFirebaseToken(current.refreshToken).then((t) =>
            this.store({ ...current, accessToken: t.idToken, refreshToken: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 }),
          )
        : this.request("/token?grant_type=refresh_token", { refresh_token: current.refreshToken }).then((body) => this.accept(body))
    this.refreshing = next
      .catch(async (err) => {
        if (err instanceof AuthError && (err.code === "invalid_grant" || err.code === "refresh_token_not_found" || err.code === "refresh_token_already_used" || err.code === "HTTP_400" || err.code === "HTTP_401")) {
          this.onSignedOut?.(`session refresh rejected (${err.code}): ${err.message}`)
          await this.signOut()
          return null
        }
        // Network problem: keep the session and retry soon.
        this.schedule(30_000)
        throw err
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  private async accept(body: any): Promise<AuthSession> {
    const meta = body.user?.user_metadata ?? {}
    const session: AuthSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at ? body.expires_at * 1000 : Date.now() + (body.expires_in ?? 3600) * 1000,
      issuer: "supabase",
      user: {
        id: body.user?.id,
        email: body.user?.email ?? null,
        name: meta.full_name ?? meta.name ?? null,
        avatarUrl: meta.avatar_url ?? meta.picture ?? null,
        provider: body.user?.app_metadata?.provider ?? null,
      },
    }
    return this.store(session)
  }

  private async store(session: AuthSession): Promise<AuthSession> {
    this.session = session
    await writeSecret("auth-session", session)
    this.schedule()
    this.emit()
    return session
  }

  private schedule(delay?: number) {
    this.clearTimer()
    if (!this.session) return
    const wait = delay ?? Math.max(5_000, this.session.expiresAt - Date.now() - 120_000)
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => undefined), wait)
  }

  private clearTimer() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  private emit() {
    for (const listener of this.listeners) listener(this.session)
  }

  private assertConfigured() {
    if (!isAuthConfigured()) {
      throw new AuthError("BambooKit sign-in is not configured in this build (missing Supabase URL or anon key).", "AUTH_NOT_CONFIGURED")
    }
  }

  private async request(path: string, payload: unknown): Promise<any> {
    this.assertConfigured()
    let res: Response
    try {
      res = await fetch(`${BAMBOOKIT_CONFIG.supabaseUrl}/auth/v1${path}`, {
        method: "POST",
        headers: { apikey: BAMBOOKIT_CONFIG.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    } catch (err: any) {
      throw new AuthError(`Cannot reach BambooKit sign-in service: ${err.message}`, "NETWORK")
    }
    const text = await res.text()
    let body: any = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { msg: text.slice(0, 200) }
    }
    if (!res.ok) {
      const message = body.error_description || body.msg || body.message || `Sign-in service error (${res.status})`
      throw new AuthError(message, body.error_code || body.error || `HTTP_${res.status}`)
    }
    return body
  }
}

