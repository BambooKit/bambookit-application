export type BambooKitLinkState = "disabled" | "offline" | "connecting" | "connected" | "error"

export interface BambooKitAccount {
  id: string
  email: string | null
  name: string | null
  avatarUrl: string | null
  provider: string | null
}

export interface BambooKitState {
  configured: boolean
  apiUrl: string
  account: BambooKitAccount | null
  device: { id: string; name: string; fingerprint: string } | null
  api: BambooKitLinkState
  realtime: BambooKitLinkState
  opencode: BambooKitLinkState
  pairedPhones: number
  error: string | null
}

export interface BambooKitDevice {
  id: string
  kind: "desktop" | "mobile"
  name: string
  platform: string
  appVersion: string | null
  online: boolean
  lastSeenAt: string | null
  linkedDevices: Array<{ id: string; name: string; kind: string; platform: string }>
}

export type BambooKitResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string | null }

/** Exposed by the BambooKit Desktop preload as window.api.bambookit. Absent in the web build. */
export interface BambooKitBridgeAPI {
  getState: () => Promise<BambooKitResult<BambooKitState>>
  signIn: (email: string, password: string) => Promise<BambooKitResult<BambooKitAccount>>
  signUp: (email: string, password: string, name?: string) => Promise<BambooKitResult<{ user: BambooKitAccount | null; confirmationRequired: boolean }>>
  signInWithGoogle: () => Promise<BambooKitResult<BambooKitAccount>>
  resendConfirmation: (email: string) => Promise<BambooKitResult<void>>
  resetPassword: (email: string) => Promise<BambooKitResult<void>>
  signOut: () => Promise<BambooKitResult<void>>
  createPairing: () => Promise<BambooKitResult<{ uri: string; expiresAt: string; ttlSeconds: number }>>
  listDevices: () => Promise<BambooKitResult<BambooKitDevice[]>>
  unlinkDevice: (id: string) => Promise<BambooKitResult<void>>
  revokeDevice: (id: string) => Promise<BambooKitResult<void>>
  renameDevice: (name: string) => Promise<BambooKitResult<void>>
  onState: (cb: (state: BambooKitState) => void) => () => void
  onEvent: (cb: (event: { type: string; [key: string]: unknown }) => void) => () => void
}
