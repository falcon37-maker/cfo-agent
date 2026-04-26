// Application-level credential encryption.
//
// AES-256-GCM with a key from CREDENTIAL_ENCRYPTION_KEY (32 bytes, hex or
// base64). Each ciphertext envelope is a base64 string of: IV (12 bytes) ‖
// ciphertext ‖ auth tag (16 bytes). Decrypt is single-shot — no streaming,
// since secrets are tiny.
//
// Why app-level instead of Supabase Vault: Vault adds another moving part
// (extension, RPC) and ties us to a specific Supabase release. App-level
// keeps the encryption boundary at our process and lets us rotate keys by
// re-encrypting in a script.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and add it to your env.",
    );
  }
  // Accept either base64 (44 chars including padding) or hex (64 chars).
  let key: Buffer;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY must be base64 or hex.");
    }
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length}).`,
    );
  }
  cachedKey = key;
  return key;
}

/** Encrypt a plaintext string. Returns a base64 envelope safe to store
 *  in TEXT columns. */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decrypt a base64 envelope produced by encrypt(). Throws on tamper or
 *  wrong key. */
export function decrypt(envelope: string): string {
  const key = loadKey();
  const buf = Buffer.from(envelope, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext envelope too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/** True iff CREDENTIAL_ENCRYPTION_KEY is set and valid. Used to gate
 *  DB-stored credentials on routes that may run before the env is wired. */
export function hasEncryptionKey(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
