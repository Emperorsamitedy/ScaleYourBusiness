// The weekly summary's switch rules and stop token — idea 42. Pure: no
// database, so the rules are pinned by unit tests. ./prefs reads and
// writes; this decides.
//
// The switch is the owner's own users.notification_prefs (data-model §4's
// NotificationPrefs, typed here now that a notification exists):
//   weekly_summary: true | false | absent.
// Absent means the default: ON once the business has a mode decision
// (watching, or acting right away) — before that there is no week of work
// to report. An explicit false is the owner's word and always wins; an
// explicit true still sends nothing until there is a mode decision.
//
// The stop link is a signed token, `<user id>.<HMAC>`, keyed by a purpose
// label over CONNECTOR_KEY (lib/core/derived-key's stableKey), so a link
// in an old email keeps working for ever, the way unsubscribe links do.
// It is NOT lib/unsubscribe's token: that one is minted per customer send
// and fenced to the suppression list; the owner is not a contact. The
// token is the whole credential — no cookie is read — and it can do one
// thing only: switch this owner's summary off.

import { createHmac, timingSafeEqual } from "node:crypto";
import { stableKey } from "../core/derived-key";

export const SUMMARY_PREF_KEY = "weekly_summary";

/** What the owner said, if anything: true, false, or null for "never said". */
export function summaryPref(prefs: unknown): boolean | null {
  if (prefs === null || typeof prefs !== "object") return null;
  const value = (prefs as Record<string, unknown>)[SUMMARY_PREF_KEY];
  return typeof value === "boolean" ? value : null;
}

/** Whether this week's email goes out: in care, and not switched off. */
export function summaryOn(pref: boolean | null, hasModeDecision: boolean): boolean {
  return hasModeDecision && pref !== false;
}

/** P6-07: how the owner wants it — email (the default), WhatsApp, or both. */
export const SUMMARY_CHANNEL_KEY = "weekly_summary_channel";
export const SUMMARY_CHANNELS = ["email", "whatsapp", "both"] as const;
export type SummaryChannel = (typeof SUMMARY_CHANNELS)[number];

export function isSummaryChannel(v: unknown): v is SummaryChannel {
  return typeof v === "string" && (SUMMARY_CHANNELS as readonly string[]).includes(v);
}

/** The owner's channel; anything absent or unreadable is the default, email. */
export function summaryChannel(prefs: unknown): SummaryChannel {
  if (prefs === null || typeof prefs !== "object") return "email";
  const value = (prefs as Record<string, unknown>)[SUMMARY_CHANNEL_KEY];
  return isSummaryChannel(value) ? value : "email";
}

/** Whether a channel carries the email / the WhatsApp message. */
export const wantsEmail = (c: SummaryChannel): boolean => c !== "whatsapp";
export const wantsWhatsApp = (c: SummaryChannel): boolean => c !== "email";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<uuid>.<43 base64url chars>`. Checked before anything else. */
export const STOP_TOKEN_RE = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i;

const stopMac = (userId: string) =>
  createHmac("sha256", stableKey("syb-weekly-summary-stop-v1"))
    .update(`weekly-summary-stop:${userId.toLowerCase()}`)
    .digest("base64url");

export function stopToken(userId: string): string {
  return `${userId.toLowerCase()}.${stopMac(userId)}`;
}

/** The user a stop token was minted for, or null for anything SYB didn't sign. */
export function verifyStopToken(token: string): string | null {
  if (!STOP_TOKEN_RE.test(token)) return null;
  const dot = token.indexOf(".");
  const userId = token.slice(0, dot);
  if (!UUID_RE.test(userId)) return null;
  const want = Buffer.from(stopMac(userId));
  const got = Buffer.from(token.slice(dot + 1));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return userId.toLowerCase();
}
