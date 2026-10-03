import { ipcMain } from "electron"
import { bambookitSupervisor } from "./index"

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
  handle("bambookit:resend-confirmation", (email: string) => bambookitSupervisor.resendConfirmation(String(email)))
  handle("bambookit:reset-password", (email: string) => bambookitSupervisor.sendPasswordReset(String(email)))
  handle("bambookit:sign-out", () => bambookitSupervisor.signOut())
  handle("bambookit:create-pairing", () => bambookitSupervisor.createPairingToken())
  handle("bambookit:list-devices", () => bambookitSupervisor.listDevices())
  handle("bambookit:unlink-device", (id: string) => bambookitSupervisor.unlinkDevice(String(id)))
  handle("bambookit:revoke-device", (id: string) => bambookitSupervisor.revokeDevice(String(id)))
  handle("bambookit:rename-device", (name: string) => bambookitSupervisor.renameDevice(String(name)))
}
