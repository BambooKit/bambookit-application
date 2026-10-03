import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { readSecret, writeSecret } from "./secure-store"

interface StoredIdentity {
  publicKeyPem: string
  privateKeyPem: string
  createdAt: string
}

/**
 * Ed25519 device identity. The private key is stored encrypted with the OS keystore and is only
 * used inside the main process to sign API requests. It is never sent to the renderer, the API,
 * the phone, logs, or OpenCode agents.
 */
export class DeviceIdentity {
  private constructor(
    readonly publicKeyPem: string,
    private readonly privateKey: KeyObject,
  ) {}

  static async load(): Promise<DeviceIdentity> {
    let stored = await readSecret<StoredIdentity>("device-identity")
    if (!stored) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      stored = {
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        createdAt: new Date().toISOString(),
      }
      await writeSecret("device-identity", stored)
    }
    return new DeviceIdentity(stored.publicKeyPem, createPrivateKey(stored.privateKeyPem))
  }

  /** Short fingerprint for display (never used as a secret). */
  get fingerprint(): string {
    return createHash("sha256").update(this.publicKeyPem).digest("hex").slice(0, 12)
  }

  /** Headers proving the request comes from this device. Must match bambookit-api signingPayload(). */
  signRequest(method: string, pathWithQuery: string, body: string): Record<string, string> {
    const timestamp = String(Date.now())
    const payload = `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${createHash("sha256").update(body).digest("hex")}`
    return {
      "X-BK-Timestamp": timestamp,
      "X-BK-Signature": sign(null, Buffer.from(payload), this.privateKey).toString("base64"),
    }
  }
}
