// The day-30 shadow summary as a shareable artifact (the v1 spec §4.2:
// "build it as a first-class, shareable artifact, not a dashboard tab").
//
// A link carries the business's id and an expiry, signed with a key of its
// own (HMAC-SHA-256 over COOKIE_SECRET/CONNECTOR_KEY, labelled for this);
// it opens the summary and nothing else, and it can't be forged or extended.

import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedKey } from "../core/derived-key";

export const SHARE_DAYS = 30;
const LABEL = "syb:shadow-summary-share:v1";

const b64 = (b: Buffer) => b.toString("base64url");

export function shareToken(profileId: string, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + SHARE_DAYS * 86_400;
  const body = `${profileId}.${exp}`;
  const sig = createHmac("sha256", derivedKey(LABEL)).update(body).digest();
  return `${b64(Buffer.from(body))}.${b64(sig)}`;
}

/** The business the token names, or null: forged, malformed or expired. */
export function readShareToken(token: string, now = new Date()): string | null {
  const [bodyB64, sigB64] = token.split(".");
  if (!bodyB64 || !sigB64) return null;
  const body = Buffer.from(bodyB64, "base64url").toString("utf8");
  const want = createHmac("sha256", derivedKey(LABEL)).update(body).digest();
  const got = Buffer.from(sigB64, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const [profileId, exp] = body.split(".");
  if (!profileId || !/^[0-9a-f-]{36}$/i.test(profileId)) return null;
  if (!exp || Number(exp) * 1000 < now.getTime()) return null;
  return profileId;
}
