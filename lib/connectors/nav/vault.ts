// NAV credentials at rest — the multi-market spec §E.5, the highest tier.
//
// Encrypted with a key of their own per business: HKDF-SHA-256 over the
// environment's CONNECTOR_KEY, salted with the account's id and labelled
// for NAV. A blob copied to another account's row doesn't decrypt there,
// and no other connector's key opens it. AES-256-GCM as everywhere else
// (lib/connectors/secrets.ts), so a tampered blob fails rather than
// decrypting to garbage.
//
// The plaintext exists only inside withNavCredentials' callback, and is
// registered with the redaction filter for that call, so a log line that
// somehow carries it prints [redacted] instead.

import { hkdfSync } from "node:crypto";
import { env } from "../../env";
import { decryptSecret, encryptSecret, parseKey } from "../secrets";
import type { NavCredentials } from "./protocol";
import { forgetSecret, installNavRedaction, rememberSecret } from "./redact";

const INFO = "syb:nav-online-szamla:credentials:v1";

// Every log writer passes through the redaction filter before any NAV
// credential can be opened in this process.
installNavRedaction();

/** The per-business key. */
export function navKeyFor(accountId: string, master: Buffer = parseKey(env.CONNECTOR_KEY)): Buffer {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("a NAV key belongs to an account id");
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(accountId, "utf8"), INFO, 32));
}

export function sealNavCredentials(accountId: string, c: NavCredentials, master?: Buffer): string {
  return encryptSecret(JSON.stringify(c), navKeyFor(accountId, master));
}

function open(accountId: string, blob: string, master?: Buffer): NavCredentials {
  const parsed = JSON.parse(decryptSecret(blob, navKeyFor(accountId, master))) as NavCredentials;
  for (const k of ["login", "password", "signatureKey", "taxNumber"] as const) {
    if (typeof parsed[k] !== "string") throw new Error("the stored NAV credentials are incomplete");
  }
  return parsed;
}

/** Use the credentials for one call; they are redacted from every log line meanwhile. */
export async function withNavCredentials<T>(
  accountId: string,
  blob: string,
  work: (c: NavCredentials) => Promise<T>,
  master?: Buffer,
): Promise<T> {
  const c = open(accountId, blob, master);
  installNavRedaction();
  const secrets = [c.password, c.signatureKey, c.login];
  secrets.forEach(rememberSecret);
  try {
    return await work(c);
  } finally {
    secrets.forEach(forgetSecret);
  }
}
