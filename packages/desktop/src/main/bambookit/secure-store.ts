import { app, safeStorage } from "electron"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Small encrypted key/value files under <userData>/bambookit. Encryption uses the OS keystore via
 * Electron safeStorage (DPAPI on Windows). We refuse to persist secrets if encryption is unavailable.
 */
function dir() {
  return join(app.getPath("userData"), "bambookit")
}

export async function writeSecret(name: string, value: unknown): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable; refusing to store secrets")
  await mkdir(dir(), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(value))
  await writeFile(join(dir(), `${name}.bin`), encrypted, { mode: 0o600 })
}

export async function readSecret<T>(name: string): Promise<T | null> {
  try {
    const buf = await readFile(join(dir(), `${name}.bin`))
    return JSON.parse(safeStorage.decryptString(buf)) as T
  } catch {
    return null
  }
}

export async function deleteSecret(name: string): Promise<void> {
  await rm(join(dir(), `${name}.bin`), { force: true })
}

/** Non-secret state (e.g. last realtime sequence number). */
export async function writeState(name: string, value: unknown): Promise<void> {
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), `${name}.json`), JSON.stringify(value))
}

export async function readState<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(dir(), `${name}.json`), "utf8")) as T
  } catch {
    return null
  }
}
