// A call recording at rest — P6-08. SYB's media store hands out addresses
// (lib/content/media); a recording must never be playable from one. So the
// bytes stored are sealed: AES-256-GCM under a key derived from
// CONNECTOR_KEY (HKDF, its own label, so it is never the connection-secrets
// key itself). A leaked storage address is noise; a tampered file fails to
// open rather than playing something else. Only the owner-gated playback
// route opens one.
//
// Format: "SYBREC1" · 12-byte IV · 16-byte tag · ciphertext.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { parseKey } from "../connectors/secrets";
import { env } from "../env";

const MAGIC = Buffer.from("SYBREC1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = "syb phone recording v1";

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** The sealing key: HKDF-SHA256 over CONNECTOR_KEY's 32 bytes. Throws when the key is missing or malformed. */
export function recordingKey(raw: string = env.CONNECTOR_KEY): Buffer {
  return Buffer.from(hkdfSync("sha256", parseKey(raw), Buffer.alloc(0), INFO, 32));
}

/** True when CONNECTOR_KEY can seal a recording. */
export function recordingKeyReady(): boolean {
  try {
    recordingKey(process.env.CONNECTOR_KEY ?? "");
    return true;
  } catch {
    return false;
  }
}

export function sealAudio(plain: Uint8Array, key: Buffer): Uint8Array {
  if (plain.byteLength === 0) throw new SealError("refusing to seal empty audio");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]));
}

/** Open sealed audio. The wrong key, a truncated file or any tampering throws. */
export function openAudio(sealed: Uint8Array, key: Buffer): Uint8Array {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const head = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (buf.length <= head || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SealError("not a sealed recording");
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buf.subarray(MAGIC.length + IV_BYTES, head);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(head)), decipher.final()]));
  } catch {
    throw new SealError("the recording could not be opened");
  }
}
