// The weekly summary on WhatsApp — P6-07 (idea 42's follow-up). Pure apart
// from `sendWhatsApp`, whose fetch is injected: no database, no clock.
//
// WhatsApp only lets a business START a conversation with a template Meta
// has approved, so the message is one fixed template
// (specs/whatsapp-summary-v1.md has its exact words in every language)
// with four variables:
//
//   {{1}} the business's name          {{2}} the week ("20–26 Oct 2026")
//   {{3}} a one-line digest of the composed summary: its lines joined with
//         " · ", capped, with "and N more" for what didn't fit
//   {{4}} the link to the Watching screen, where all of it lives
//
// A variable may not hold a newline or a tab, nor more than four spaces in
// a row (WhatsApp refuses the whole message), so `cleanVariable` folds every
// run of whitespace to one space — and `variableProblems` checks the result
// before anything is sent. The digest reads the email's own composed
// sections (./compose), so the two channels can never tell different weeks.
//
// The send is Twilio's Messages API: one POST, HTTP Basic auth with the
// account SID and auth token (lib/env's whatsappEnv, the phone line's own
// keys). Its outcome is sorted the way the email's is: "sent" only with
// Twilio's message SID; "refused" for a 4xx, which means nothing went out;
// "unknown" when it may have. Nothing here retries.

import type { WhatsAppEnv } from "../env";
import type { Words } from "../i18n/recipient";
import { E164_RE } from "../phone/twilio";
import type { ComposedSummary } from "./compose";

export { E164_RE, toE164 } from "../phone/twilio";

/** Bumped whenever the opt-in sentence on /watch changes; recorded with every yes. */
export const WHATSAPP_CONSENT_VERSION = "whatsapp-summary-v1";

/** The template's four variables, by Twilio's numbered keys. */
export type WhatsAppVariables = { "1": string; "2": string; "3": string; "4": string };

/** Caps per variable, in characters — Twilio advises under 250 a value; the digest is the long one. */
export const VARIABLE_CAPS: Readonly<Record<keyof WhatsAppVariables, number>> = {
  "1": 60,
  "2": 60,
  "3": 480,
  "4": 200,
};
/** All four together stay under this: with the template's ~250 own characters, well inside Meta's 1,024. */
export const VARIABLES_CAP = 900;
/** Between digest lines. */
export const DIGEST_SEPARATOR = " · ";

const len = (s: string) => Array.from(s).length;

/**
 * Pure: a value WhatsApp will take — every newline, tab and run of spaces
 * folded to one space, trimmed, and cut to `cap` characters with "…".
 */
export function cleanVariable(raw: string, cap: number): string {
  const one = raw.replace(/\s+/gu, " ").trim();
  if (len(one) <= cap) return one;
  return `${Array.from(one)
    .slice(0, Math.max(0, cap - 1))
    .join("")
    .trimEnd()}…`;
}

/** Pure: what's wrong with a set of variables, if anything — checked before every send. */
export function variableProblems(vars: WhatsAppVariables): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const key of ["1", "2", "3", "4"] as const) {
    const v = vars[key];
    total += len(v);
    if (v.trim() === "") problems.push(`${key}: empty`);
    if (/[\r\n]/.test(v)) problems.push(`${key}: newline`);
    if (/\t/.test(v)) problems.push(`${key}: tab`);
    if (/ {5,}/.test(v)) problems.push(`${key}: more than four spaces`);
    if (len(v) > VARIABLE_CAPS[key]) problems.push(`${key}: over ${VARIABLE_CAPS[key]}`);
  }
  if (total > VARIABLES_CAP) problems.push(`total: over ${VARIABLES_CAP}`);
  return problems;
}

/**
 * Pure: the composed summary as one line — its lines in the email's order,
 * joined with " · ", as many as fit `cap`, then "and N more" (the email's
 * own words) for the rest, held-back lines included. A quiet week is the
 * email's quiet sentence.
 */
export function summaryDigest(
  composed: Pick<ComposedSummary, "quiet" | "sections">,
  w: Words,
  cap: number = VARIABLE_CAPS["3"],
): string {
  const lines = composed.sections
    .flatMap((s) => s.lines.map((l) => l.text))
    .map((t) => cleanVariable(t.replace(/^[—–-]\s+/u, ""), cap))
    .filter((t) => t !== "");
  const held = composed.sections.reduce((n, s) => n + s.more, 0);
  if (lines.length === 0 && held === 0) return cleanVariable(w.t("quiet"), cap);

  const more = (n: number) => (n > 0 ? `${DIGEST_SEPARATOR}${w.t("more", { count: n })}` : "");
  const build = (kept: number) => lines.slice(0, kept).join(DIGEST_SEPARATOR);
  let kept = lines.length;
  while (kept > 0 && len(build(kept) + more(lines.length - kept + held)) > cap) kept--;
  if (kept > 0) return build(kept) + more(lines.length - kept + held);

  // Not even the first line fits beside "and N more": cut it to make room.
  const rest = w.t("more", { count: lines.length - 1 + held });
  const suffix = lines.length - 1 + held > 0 ? `${DIGEST_SEPARATOR}${rest}` : "";
  const room = Math.max(1, cap - len(suffix));
  return cleanVariable(cleanVariable(lines[0] ?? rest, room) + suffix, cap);
}

/**
 * Pure: the template's four variables for one week. `w` is emails.summary in
 * the TEMPLATE's language (the owner's when they have a template, English
 * when it fell back), and `composed` composed in that same language.
 */
export function whatsappVariables(args: {
  business: string | null;
  composed: Pick<ComposedSummary, "period" | "quiet" | "sections">;
  origin: string;
  w: Words;
}): WhatsAppVariables {
  const one = cleanVariable(args.business ?? args.w.t("whatsappBusiness"), VARIABLE_CAPS["1"]);
  const two = cleanVariable(args.composed.period, VARIABLE_CAPS["2"]);
  const four = cleanVariable(`${args.origin}/watch`, VARIABLE_CAPS["4"]);
  const room = Math.min(VARIABLE_CAPS["3"], VARIABLES_CAP - len(one) - len(two) - len(four));
  return { "1": one, "2": two, "3": summaryDigest(args.composed, args.w, room), "4": four };
}

/** Pure: the template for a language — its own when it has one, English's otherwise. */
export function templateFor(
  templates: Readonly<Record<string, string>>,
  locale: string,
): { locale: string; content_sid: string } | null {
  const own = templates[locale];
  if (own) return { locale, content_sid: own };
  const en = templates.en;
  return en ? { locale: "en", content_sid: en } : null;
}

/** Pure: a number as the owner's screen shows it — the last three digits only. */
export function maskNumber(e164: string): string {
  return `•••${e164.slice(-3)}`;
}

/* ── Twilio's Messages API ── */

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
export const WHATSAPP_TIMEOUT_MS = 20_000;

export interface WhatsAppMessage {
  to: string;
  content_sid: string;
  variables: WhatsAppVariables;
}

/** Pure: the exact request — URL, Basic auth, and the form body Twilio documents. */
export function whatsappRequest(
  env: WhatsAppEnv,
  msg: WhatsAppMessage,
): { url: string; init: RequestInit & { body: string; headers: Record<string, string> } } {
  if (!E164_RE.test(msg.to)) throw new Error("whatsapp: recipient is not E.164");
  const body = new URLSearchParams({
    From: `whatsapp:${env.from}`,
    To: `whatsapp:${msg.to}`,
    ContentSid: msg.content_sid,
    ContentVariables: JSON.stringify(msg.variables),
  }).toString();
  return {
    url: `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(env.accountSid)}/Messages.json`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  };
}

export type WhatsAppOutcome =
  | { kind: "sent"; sid: string }
  | { kind: "refused"; status: number; code: number | null }
  | { kind: "unknown"; why: string };

export type TwilioFetch = (url: string, init: RequestInit) => Promise<Response>;

const MESSAGE_SID_RE = /^(SM|MM)[0-9a-f]{32}$/i;

/** Pure: Twilio's answer sorted — sent with a SID, refused on a 4xx, unknown otherwise. */
export function whatsappOutcome(status: number, body: unknown): WhatsAppOutcome {
  const b = (body ?? {}) as { sid?: unknown; status?: unknown; code?: unknown };
  if (status >= 200 && status < 300) {
    if (b.status === "failed" || b.status === "undelivered") {
      return { kind: "refused", status, code: typeof b.code === "number" ? b.code : null };
    }
    return typeof b.sid === "string" && MESSAGE_SID_RE.test(b.sid)
      ? { kind: "sent", sid: b.sid }
      : { kind: "unknown", why: `Twilio answered ${status} without a message SID` };
  }
  if (status >= 400 && status < 500 && status !== 409) {
    return { kind: "refused", status, code: typeof b.code === "number" ? b.code : null };
  }
  return { kind: "unknown", why: `Twilio answered ${status}` };
}

/** One POST, never retried. Variables that break WhatsApp's rules are refused before the call. */
export async function sendWhatsApp(
  env: WhatsAppEnv,
  msg: WhatsAppMessage,
  fetchImpl: TwilioFetch = fetch,
): Promise<WhatsAppOutcome> {
  if (variableProblems(msg.variables).length > 0) {
    return { kind: "refused", status: 0, code: null };
  }
  const { url, init } = whatsappRequest(env, msg);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.name : "network" };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return whatsappOutcome(res.status, body);
}
