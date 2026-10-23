// Inbound support email, the provider half — Phase 4 Session C (P4-09).
//
// Resend's receiving, as its docs describe it (read 2026-10-19):
//   · the webhook is an `email.received` event carrying METADATA only —
//     { type, created_at, data: { email_id, created_at, from, to[], cc[],
//     bcc[], received_for[], message_id, subject, attachments[] } }. The
//     docs say outright that the body, headers and attachments are not in
//     it;
//   · the body and headers come from GET /emails/receiving/{id}, which
//     answers { id, from, to[], cc[], received_for[], subject, text|null,
//     html, headers{name: value}, message_id, created_at, … };
//   · deliveries are signed the Svix way: headers svix-id, svix-timestamp
//     (seconds) and svix-signature ("v1,<base64>" entries, space-
//     separated); the signed content is "<id>.<timestamp>.<raw body>",
//     HMAC-SHA256 under the base64 part of the whsec_ secret.
//
// Everything here is normalised to ONE shape, InboundEmail, so nothing
// past this file knows which provider the mail came through. No network
// in tests: the fetch is a seam, and the fixtures are recorded-shape.
//
// Stranger-facing (rule 21): this file sits in lib/support and imports
// nothing but node:crypto.

import { createHmac, timingSafeEqual } from "node:crypto";

/** A delivery older or newer than this is refused — Svix's own library uses five minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
/** The body kept per email. Longer mail is cut here, and the row says it was cut. */
export const SUPPORT_EMAIL_BODY_MAX_CHARS = 20_000;
export const SUPPORT_EMAIL_SUBJECT_MAX_CHARS = 300;

export interface InboundEmail {
  /** The provider's own id for this email — the idempotency key. */
  provider_id: string;
  from: { address: string; name: string | null };
  /** Every address the mail was for: To, Cc, Bcc and the forwarding trail (received_for). */
  to: string[];
  subject: string;
  text: string;
  truncated: boolean;
  /** Angle brackets included, as the headers carry them; null when absent. */
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  received_at: string;
  /** Review #18: did the sender pass authentication, by the receiving server's own result? */
  sender_auth: SenderAuth;
}

/* ── sender authentication (review 2026-10-23, #18) ── */

export type SenderAuth = "verified" | "unverified" | "failed";

/**
 * Whether the From address is the sender's own, from Resend's
 * `authentication` object on the retrieved email ({ spf, dkim, dmarc },
 * each "pass" | "fail" | "gray" | "processing_failed" | "unknown", or the
 * whole object null for mail received before Resend added it). Resend's
 * docs (read 2026-10-23) say these come from its receiving server, not
 * from the message headers, so the sender cannot forge them.
 *
 * Deliberately NOT read: an Authentication-Results header in the mail.
 * Headers are the sender's to write, and a forged "dmarc=pass" is exactly
 * what this check exists to catch.
 *
 *   verified    dmarc "pass", or dkim "pass" (Resend calls a DKIM
 *               signature for another domain "gray", so a pass is aligned);
 *   failed      dmarc or dkim "fail" with no pass;
 *   unverified  anything else — no result, no DMARC policy, unsigned. SPF
 *               alone proves nothing about the From line, and forwarding
 *               (how this inbox is fed) breaks it anyway.
 */
export function senderAuthOf(content: unknown): SenderAuth {
  if (typeof content !== "object" || content === null) return "unverified";
  const auth = (content as { authentication?: unknown }).authentication;
  if (typeof auth !== "object" || auth === null) return "unverified";
  const { dkim, dmarc } = auth as { dkim?: unknown; dmarc?: unknown };
  if (dmarc === "pass" || dkim === "pass") return "verified";
  if (dmarc === "fail" || dkim === "fail") return "failed";
  return "unverified";
}

/* ── signature verification (Svix scheme) ── */

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

export function verifyWebhook(args: {
  rawBody: string;
  headers: { id: string | null; timestamp: string | null; signature: string | null };
  secret: string;
  now?: Date;
}): VerifyOutcome {
  const { id, timestamp, signature } = args.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  const nowSec = Math.floor((args.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const encoded = args.secret.startsWith("whsec_") ? args.secret.slice(6) : args.secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) return { ok: false, reason: "unusable secret" };
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${args.rawBody}`).digest();
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no signature matched" };
}

/** Sign as Svix does — for the fixtures, so a test can deliver a validly signed webhook. */
export function signWebhook(
  rawBody: string,
  id: string,
  timestamp: string,
  secret: string,
): string {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const sig = createHmac("sha256", Buffer.from(encoded, "base64"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${sig}`;
}

/* ── the event ── */

export interface ReceivedEvent {
  email_id: string;
  created_at: string;
  from: string;
  to: string[];
  subject: string;
  message_id: string | null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The webhook body, read defensively. Null = not an email.received event
 * (Resend sends other event types to the same endpoint if subscribed);
 * those are acknowledged and ignored.
 */
export function parseReceivedEvent(body: unknown): ReceivedEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { type?: unknown; created_at?: unknown; data?: unknown };
  if (b.type !== "email.received" || typeof b.data !== "object" || b.data === null) return null;
  const d = b.data as Record<string, unknown>;
  if (typeof d.email_id !== "string" || d.email_id === "") return null;
  return {
    email_id: d.email_id,
    created_at:
      typeof d.created_at === "string"
        ? d.created_at
        : typeof b.created_at === "string"
          ? b.created_at
          : new Date().toISOString(),
    from: typeof d.from === "string" ? d.from : "",
    to: [...strings(d.to), ...strings(d.cc), ...strings(d.bcc), ...strings(d.received_for)],
    subject: typeof d.subject === "string" ? d.subject : "",
    message_id: typeof d.message_id === "string" ? d.message_id : null,
  };
}

/* ── addresses ── */

const ADDRESS_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** "Ana Kovács <ana@example.com>" → { address: "ana@example.com", name: "Ana Kovács" }. */
export function parseAddress(raw: string): { address: string; name: string | null } | null {
  const trimmed = raw.trim();
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  const address = (angled ? angled[2]! : trimmed).trim().toLowerCase();
  if (!ADDRESS_RE.test(address)) return null;
  const name = angled
    ? angled[1]!
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim()
    : "";
  return { address, name: name === "" ? null : name.slice(0, 200) };
}

export function isEmailAddress(raw: string): boolean {
  return ADDRESS_RE.test(raw.trim().toLowerCase());
}

/* ── the body ── */

/**
 * HTML to plain text, simply and safely: scripts, styles and comments
 * dropped, block ends turned into line breaks, every other tag removed,
 * the common entities decoded. The result is only ever rendered as text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function capBody(text: string): { text: string; truncated: boolean } {
  // NUL bytes cannot be stored in a Postgres text column.
  const clean = text.replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("");
  return clean.length > SUPPORT_EMAIL_BODY_MAX_CHARS
    ? { text: clean.slice(0, SUPPORT_EMAIL_BODY_MAX_CHARS), truncated: true }
    : { text: clean, truncated: false };
}

/* ── threading headers (review 2026-10-23, #17) ── */

/** The longest Message-ID kept. Real ones are under 100 characters; this leaves room. */
export const MESSAGE_ID_MAX_CHARS = 250;
/** The most ids kept from a References header (the newest: they are the nearest parents). */
export const REFERENCES_MAX_IDS = 50;
/** The most addresses stored per email (routing reads them all first). */
export const STORED_ADDRESSES_MAX = 50;
export const ADDRESS_MAX_CHARS = 254;

/**
 * One Message-ID, angle brackets included, or null when it isn't one:
 * printable ASCII, a single "@", nothing that could fold or break a
 * header (no spaces, no CR/LF, no brackets inside), and bounded in length.
 * A bare id without brackets (as Resend's `message_id` may give it) is bracketed.
 */
export function normaliseMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const id = trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
  if (id.length > MESSAGE_ID_MAX_CHARS) return null;
  return /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(id) && /^<[^@]+@[^@]+>$/.test(id) ? id : null;
}

/** Every valid Message-ID a header names, in order, deduplicated, at most `max` (the newest). */
export function messageIdsIn(header: string | null, max = REFERENCES_MAX_IDS): string[] {
  if (!header) return [];
  const ids = (header.match(/<[^<>\s]*>/g) ?? [])
    .map((id) => normaliseMessageId(id))
    .filter((id): id is string => id !== null);
  return [...new Set(ids)].slice(-max);
}

/** A header from Resend's name → value map, whatever case the name came in. */
function header(headers: unknown, name: string): string | null {
  if (typeof headers !== "object" || headers === null) return null;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === "string") return v.trim() || null;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim() || null;
  }
  return null;
}

/** Normalise the retrieved email (GET /emails/receiving/{id}) with its event. */
export function normaliseReceived(event: ReceivedEvent, content: unknown): InboundEmail | null {
  const c = (typeof content === "object" && content !== null ? content : {}) as Record<
    string,
    unknown
  >;
  const from = parseAddress(typeof c.from === "string" ? c.from : event.from);
  if (!from) return null;
  const to = [
    ...new Set(
      [...strings(c.to), ...strings(c.cc), ...strings(c.received_for), ...event.to]
        .map((a) => parseAddress(a)?.address)
        .filter((a): a is string => typeof a === "string"),
    ),
  ];
  const rawText =
    typeof c.text === "string" && c.text.trim() !== ""
      ? c.text
      : typeof c.html === "string"
        ? htmlToText(c.html)
        : "";
  const body = capBody(rawText);
  const subject = (typeof c.subject === "string" ? c.subject : event.subject)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, SUPPORT_EMAIL_SUBJECT_MAX_CHARS);
  return {
    provider_id: event.email_id,
    from,
    to,
    subject,
    text: body.text,
    truncated: body.truncated,
    // Stored and later copied into our replies' headers, so only well-formed,
    // bounded ids are kept: a malformed or huge header must not be able to
    // make every reply on the ticket refused (#17).
    message_id: normaliseMessageId(
      (typeof c.message_id === "string" && c.message_id.trim()) ||
        header(c.headers, "message-id") ||
        event.message_id,
    ),
    in_reply_to: messageIdsIn(header(c.headers, "in-reply-to"))[0] ?? null,
    references: messageIdsIn(header(c.headers, "references")).join(" ") || null,
    received_at: typeof c.created_at === "string" ? c.created_at : event.created_at,
    sender_auth: senderAuthOf(c),
  };
}

/* ── fetching the content ── */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class InboundFetchError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "InboundFetchError";
    this.retryable = retryable;
  }
}

/** A read Resend hasn't answered by now is retried later, not waited on (review 2026-10-23, #24). */
export const RECEIVED_FETCH_TIMEOUT_MS = 10_000;

/** GET the received email's body and headers. A read of our own Resend account, nothing more. */
export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = RECEIVED_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(emailId)) {
    throw new InboundFetchError("the email id is not one Resend issues", false);
  }
  let res: Response;
  try {
    res = await fetchImpl(`https://api.resend.com/emails/receiving/${emailId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A timeout or a dropped connection: the webhook answers 5xx and Resend redelivers.
    const name = error instanceof Error ? error.name : "network";
    throw new InboundFetchError(`Resend did not answer (${name})`, true);
  }
  if (!res.ok) {
    throw new InboundFetchError(
      `Resend answered ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  }
  return res.json();
}
