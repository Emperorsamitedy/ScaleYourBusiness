// Connection secrets at rest — P2-03, rule 10.
//
// An owner's Stripe key or shop token is encrypted with AES-256-GCM under
// a key that lives only in the environment (CONNECTOR_KEY). A leaked
// database row is therefore noise, not a leaked Stripe account. The
// ciphertext is never logged and never returned by any API — see
// toPublicConnection in service.ts, whose type has no secret member.
//
// GCM gives integrity as well as secrecy: a tampered blob fails to
// decrypt rather than decrypting to garbage that then gets sent to a
// provider. Each encryption draws a fresh random IV, so the same secret
// stored twice produces two different blobs.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Blob format version, so a future algorithm change can coexist with old rows. */
const VERSION = "v1";

/** What any log line or error must say in place of a secret. */
export const REDACTED = "[redacted]";

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * Decode CONNECTOR_KEY material: 32 bytes as hex (64 chars) or base64.
 * Anything else is refused — a short key silently truncated by the
 * cipher would be a weaker cipher than the one promised.
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new SecretError(
      `CONNECTOR_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length} — generate one with ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}

function keyFromEnv(): Buffer {
  return parseKey(env.CONNECTOR_KEY);
}

/** Encrypt a secret for storage. Output: "v1:<iv>:<tag>:<ciphertext>", all base64. */
export function encryptSecret(plaintext: string, key: Buffer = keyFromEnv()): string {
  if (plaintext === "") {
    throw new SecretError("refusing to encrypt an empty secret");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt a stored blob. Throws SecretError on the wrong key or any tampering. */
export function decryptSecret(blob: string, key: Buffer = keyFromEnv()): string {
  const parts = blob.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new SecretError("malformed secret blob");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretError("malformed secret blob");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key and tampered ciphertext are indistinguishable by design;
    // neither message must leak which.
    throw new SecretError("secret cannot be decrypted with this key");
  }
}
