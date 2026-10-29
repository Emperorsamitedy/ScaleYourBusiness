// Web Push, in code — idea 53 (I-53.3). No dependency: node:crypto only.
//
// Two standards, both small:
//
//   RFC 8291 (Message Encryption for Web Push). The payload is encrypted
//   for one browser with the "aes128gcm" content coding of RFC 8188: an
//   ECDH P-256 agreement between a fresh key pair of ours and the
//   browser's subscription key, mixed with the browser's 16-byte auth
//   secret through HKDF-SHA-256, then AES-128-GCM over one record. The
//   push service carries ciphertext it cannot read.
//
//   RFC 8292 (VAPID). Each request carries `Authorization: vapid t=<JWT>,
//   k=<public key>`: an ES256 JWT naming the push service's origin (aud),
//   an expiry at most 24 hours ahead (exp) and a contact (sub), signed with
//   SYB's own VAPID key. A subscription made with our public key accepts
//   only pushes signed with its private half.
//
// Pure functions: no database, no network, no environment. Both are tested
// against the RFCs' own example values (webpush.test.ts).

import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

/** base64url without padding, the encoding every Web Push key travels in. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode base64url (whitespace ignored; standard base64 is accepted too). */
export function fromB64url(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

export class WebPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPushError";
  }
}

/* ── RFC 8291: the payload ── */

/** Record size we declare (RFC 8291 §4: one record, rs above the payload's size). */
export const RECORD_SIZE = 4096;
/** 4096 − 86 octets of header − 1 delimiter − 16 octets of tag (RFC 8291 §4). */
export const MAX_PLAINTEXT = 3993;

export interface DerivedKeys {
  ecdh_secret: Buffer;
  prk_key: Buffer;
  key_info: Buffer;
  ikm: Buffer;
  prk: Buffer;
  cek: Buffer;
  nonce: Buffer;
}

/** RFC 8291 §3.4, step by step, so every intermediate value is testable. */
export function deriveKeys(args: {
  ecdhSecret: Buffer;
  authSecret: Buffer;
  uaPublic: Buffer;
  asPublic: Buffer;
  salt: Buffer;
}): DerivedKeys {
  const prk_key = hmac(args.authSecret, args.ecdhSecret);
  const key_info = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    args.uaPublic,
    args.asPublic,
  ]);
  const ikm = hmac(prk_key, Buffer.concat([key_info, Buffer.from([1])]));
  const prk = hmac(args.salt, ikm);
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "ascii");
  const cek = hmac(prk, Buffer.concat([cekInfo, Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([nonceInfo, Buffer.from([1])])).subarray(0, 12);
  return { ecdh_secret: args.ecdhSecret, prk_key, key_info, ikm, prk, cek, nonce };
}

function checkUaKeys(uaPublic: Buffer, authSecret: Buffer): void {
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new WebPushError("the subscription's p256dh key isn't an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) {
    throw new WebPushError("the subscription's auth secret isn't 16 bytes");
  }
}

/**
 * Encrypt one push message for one subscription (RFC 8291). The sender key
 * pair and the salt are fresh and random for every message; tests pass the
 * RFC's fixed ones to reproduce its example byte for byte.
 */
export function encryptPayload(args: {
  plaintext: Buffer;
  uaPublic: Buffer;
  authSecret: Buffer;
  /** Test only: the application server's ECDH private key (32 bytes). */
  asPrivate?: Buffer;
  /** Test only: the 16-byte salt. */
  salt?: Buffer;
}): Buffer {
  checkUaKeys(args.uaPublic, args.authSecret);
  if (args.plaintext.length > MAX_PLAINTEXT) {
    throw new WebPushError(`a push payload is at most ${MAX_PLAINTEXT} bytes`);
  }
  const ecdh = createECDH("prime256v1");
  if (args.asPrivate) ecdh.setPrivateKey(args.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = args.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new WebPushError("the salt is 16 bytes");
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = ecdh.computeSecret(args.uaPublic);
  } catch {
    throw new WebPushError("the subscription's p256dh key isn't a point on P-256");
  }
  const keys = deriveKeys({
    ecdhSecret,
    authSecret: args.authSecret,
    uaPublic: args.uaPublic,
    asPublic,
    salt,
  });
  // One record: the plaintext, then the 0x02 delimiter of a last record.
  const cipher = createCipheriv("aes-128-gcm", keys.cek, keys.nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([args.plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  // The aes128gcm header: salt (16) · rs (4) · idlen (1) · keyid = our public key (65).
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

/* ── RFC 8292: VAPID ── */

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 public key — the browser's applicationServerKey. */
  publicKey: string;
  /** base64url of the 32-byte private scalar. Never logged, never sent. */
  privateKey: string;
  /** mailto: or https: — how a push service reaches whoever runs SYB. */
  subject: string;
}

/** RFC 8292 §2: exp MUST NOT be more than 24 hours after the request. */
export const MAX_JWT_LIFETIME_S = 24 * 3600;

/** Check a VAPID key pair and subject. A string says what is wrong; never the key itself. */
export function checkVapidKeys(keys: VapidKeys): string | null {
  const pub = fromB64url(keys.publicKey);
  const priv = fromB64url(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    return "VAPID_PUBLIC_KEY isn't a base64url uncompressed P-256 public key (65 bytes)";
  }
  if (priv.length !== 32) return "VAPID_PRIVATE_KEY isn't a base64url P-256 private key (32 bytes)";
  let derived: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    derived = ecdh.getPublicKey();
  } catch {
    return "VAPID_PRIVATE_KEY isn't a valid P-256 private key";
  }
  if (!derived.equals(pub)) return "VAPID_PRIVATE_KEY doesn't belong to VAPID_PUBLIC_KEY";
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(keys.subject)) {
    return "VAPID_SUBJECT must be a mailto: address or an https: URL";
  }
  return null;
}

function jwkOf(publicKey: Buffer, privateKey?: Buffer) {
  return {
    kty: "EC",
    crv: "P-256",
    x: b64url(publicKey.subarray(1, 33)),
    y: b64url(publicKey.subarray(33, 65)),
    ...(privateKey ? { d: b64url(privateKey) } : {}),
  };
}

function privateKeyObject(keys: VapidKeys): KeyObject {
  return createPrivateKey({
    key: jwkOf(fromB64url(keys.publicKey), fromB64url(keys.privateKey)),
    format: "jwk",
  });
}

/** The push service's origin — the JWT's audience (RFC 8292 §2). */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/** Sign the VAPID JWT: ES256, raw r‖s signature (JWS), header and claims in RFC 8292's order. */
export function signVapidJwt(args: {
  keys: VapidKeys;
  audience: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}): string {
  const head = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({ aud: args.audience, exp: args.expiresAt, sub: args.keys.subject }),
    ),
  );
  const input = `${head}.${body}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKeyObject(args.keys),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(signature)}`;
}

/** Verify an ES256 JWT against a base64url public key. For tests and the RFC's example. */
export function verifyVapidJwt(jwt: string, publicKey: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const key = createPublicKey({ key: jwkOf(fromB64url(publicKey)), format: "jwk" });
    return verify(
      "sha256",
      Buffer.from(`${head}.${body}`),
      { key, dsaEncoding: "ieee-p1363" },
      fromB64url(sig),
    );
  } catch {
    return false;
  }
}

/** RFC 8292 §3: the Authorization header value. */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

/** A fresh VAPID key pair, as `npm run vapid:generate` prints it. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // getPrivateKey can be shorter than 32 bytes when it has leading zeros.
  const priv = ecdh.getPrivateKey();
  const padded = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(padded) };
}
