import { ipcMain } from "electron"
import { bambookitSupervisor } from "./index"
import { cancelSupabaseGoogle } from "./supabase-oauth"

/** Wraps handlers so the renderer receives { ok, data } / { ok: false, error, code } instead of thrown IPC errors. */
function handle(channel: string, fn: (...args: any[]) => Promise<unknown> | unknown) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), code: err?.code ?? null }
    }
  })
}

export function registerBambooKitIpc() {
  handle("bambookit:get-state", () => bambookitSupervisor.getState())
  handle("bambookit:sign-in", (email: string, password: string) => bambookitSupervisor.signIn(String(email), String(password)))
  handle("bambookit:sign-up", (email: string, password: string, name?: string) => bambookitSupervisor.signUp(String(email), String(password), name ? String(name) : undefined))
  handle("bambookit:sign-in-google", () => bambookitSupervisor.signInWithGoogle())
  handle("bambookit:cancel-google", () => cancelSupabaseGoogle())
  handle("bambookit:resend-confirmation", (email: string) => bambookitSupervisor.resendConfirmation(String(email)))
  handle("bambookit:reset-password", (email: string) => bambookitSupervisor.sendPasswordReset(String(email)))
  handle("bambookit:sign-out", () => bambookitSupervisor.signOut())
  handle("bambookit:create-pairing", () => bambookitSupervisor.createPairingToken())
  handle("bambookit:list-devices", () => bambookitSupervisor.listDevices())
  handle("bambookit:unlink-device", (id: string) => bambookitSupervisor.unlinkDevice(String(id)))
  handle("bambookit:revoke-device", (id: string) => bambookitSupervisor.revokeDevice(String(id)))
  handle("bambookit:rename-device", (name: string) => bambookitSupervisor.renameDevice(String(name)))
  handle("bambookit:set-keep-awake", (on: boolean) => bambookitSupervisor.setKeepAwake(on === true))
  handle("bambookit:set-approval-mode", (mode: string) => {
    if (mode !== "ask" && mode !== "edits" && mode !== "all") throw new Error("Unknown approval mode")
    return bambookitSupervisor.setApprovalMode(mode)
  })
  handle("bambookit:set-remote-control", (on: boolean) => bambookitSupervisor.setAllowRemoteControl(on === true))
  handle("bambookit:cancel-power", () => bambookitSupervisor.cancelPower())
  handle("bambookit:set-phone-chat-any", (on: boolean) => bambookitSupervisor.setPhoneChatAnySession(on === true))
  handle("bambookit:open-logs", () => bambookitSupervisor.openLogsFolder())
  handle("bambookit:copy-diagnostics", () => bambookitSupervisor.copyDiagnostics())
  handle("bambookit:reconnect", () => bambookitSupervisor.reconnect())
  handle("bambookit:session-opened", (id: string) => bambookitSupervisor.sessionOpened(String(id)))
  handle("bambookit:api-get", (path: string) => bambookitSupervisor.apiGet(String(path)))
}
