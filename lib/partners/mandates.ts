// Mandates — the v1 build spec §7.1, §7.6, §7.7 (P7-80, P7-82).
//
// "Partner access to a client is never implied by the firm relationship.
// It is an explicit, time-bounded, revocable grant from the business
// owner, with a scope list and an evidence reference to the engagement
// letter. The owner can revoke it in one tap and sees every partner action
// in their own audit trail."
//
//   grantMandate     the owner grants a firm a scoped, dated mandate
//   revokeMandate    one tap: revoked_at set once (a trigger forbids anything
//                    else), access ends at the next request
//   importClients    §7.6: a firm's CSV of clients → one mandate request
//                    each, emailed in the client's own language
//   grantByToken     the client answers that email with no SYB account of
//                    their own: the link proves the address, the business is
//                    made for them, the mandate is theirs to grant
// Every grant and revocation is in the owner's decision log.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  MANDATE_SCOPES,
  businessProfiles,
  decisionLog,
  firms,
  mandateRequests,
  mandates,
  users,
} from "../../db/schema";
import { sendMandateEmail } from "../auth/email";
import { createOwner, openSession } from "../auth/service";
import { parseDelimited } from "../bookings/parse";
import { bootstrapIntake } from "../intake/service";
import type { AppLocale } from "../i18n/locales";
import { isAppLocale } from "../i18n/locales";
import type { MandateScope } from "./access";
import { requireFirm } from "./firm";

export class MandateError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "MandateError";
    this.status = status;
  }
}

/** §7.1's default term, when a firm doesn't say: a year. */
export const DEFAULT_MONTHS = 12;
export const MAX_MONTHS = 36;
/** A request's link lasts a month. */
const REQUEST_DAYS = 30;
/** §7.6: one import takes a whole book. */
export const MAX_IMPORT_ROWS = 500;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function cleanScopes(raw: readonly string[]): MandateScope[] {
  const scopes = [...new Set(raw)].filter((s): s is MandateScope =>
    (MANDATE_SCOPES as readonly string[]).includes(s),
  );
  if (scopes.length === 0)
    throw new MandateError("a mandate names at least one thing the firm may do");
  return scopes;
}

function addMonths(now: Date, months: number): Date {
  if (!Number.isSafeInteger(months) || months < 1 || months > MAX_MONTHS) {
    throw new MandateError(`a mandate runs one to ${MAX_MONTHS} months`);
  }
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, now.getUTCDate(), now.getUTCHours()),
  );
}

async function logOwner(
  profileId: string,
  userId: string,
  kind: "mandate_grant" | "mandate_revoke",
  mandateId: string,
  payload: object,
) {
  await db.insert(decisionLog).values({
    profile_id: profileId,
    actor: "owner",
    kind,
    ref_id: mandateId,
    payload_hash: sha(JSON.stringify(payload)),
    user_id: userId,
  });
}

/** The owner grants. The caller has already checked that this person owns this business. */
export async function grantMandate(args: {
  ownerUserId: string;
  profileId: string;
  firmId: string;
  scopes: readonly string[];
  months?: number;
  evidenceRef: string;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const scopes = cleanScopes(args.scopes);
  const evidence = args.evidenceRef.trim();
  if (evidence === "")
    throw new MandateError("a mandate rests on an engagement letter: give its reference");
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.id, args.firmId));
  if (!firm) throw new MandateError("no such firm", 404);
  const [m] = await db
    .insert(mandates)
    .values({
      firm_id: args.firmId,
      profile_id: args.profileId,
      scopes,
      granted_by_user_id: args.ownerUserId,
      granted_at: now.toISOString(),
      expires_at: addMonths(now, args.months ?? DEFAULT_MONTHS).toISOString(),
      evidence_ref: evidence.slice(0, 200),
    })
    .returning();
  await logOwner(args.profileId, args.ownerUserId, "mandate_grant", m!.id, {
    firm_id: args.firmId,
    scopes,
    expires_at: m!.expires_at,
  });
  return m!;
}

/** One tap. Only the business's owner; the row stays, revoked. */
export async function revokeMandate(args: {
  ownerUserId: string;
  profileId: string;
  mandateId: string;
  now?: Date;
}) {
  const at = (args.now ?? new Date()).toISOString();
  const [m] = await db
    .update(mandates)
    .set({ revoked_at: at, revoked_by_user_id: args.ownerUserId })
    .where(
      and(
        eq(mandates.id, args.mandateId),
        eq(mandates.profile_id, args.profileId),
        isNull(mandates.revoked_at),
      ),
    )
    .returning();
  if (!m) throw new MandateError("no live mandate by that id", 404);
  await logOwner(args.profileId, args.ownerUserId, "mandate_revoke", m.id, {
    firm_id: m.firm_id,
    revoked_at: at,
  });
  return m;
}

/** The owner's view: every mandate on this business, with the firm's name, newest first. */
export async function mandatesOf(profileId: string) {
  return db
    .select({ mandate: mandates, firm: { id: firms.id, name: firms.name } })
    .from(mandates)
    .innerJoin(firms, eq(firms.id, mandates.firm_id))
    .where(eq(mandates.profile_id, profileId))
    .orderBy(desc(mandates.granted_at));
}

// ── §7.6: bulk onboarding ────────────────────────────────────────────────

export interface MandateEmail {
  to: string;
  locale: AppLocale;
  firm: string;
  business: string;
  link: string;
  scopes: MandateScope[];
}
export type MandateMailer = (mail: MandateEmail) => Promise<"sent" | "not_configured" | "failed">;

/**
 * The request, in the client's language, through SYB's account-email sender
 * (lib/auth/email.ts, the one place account emails leave from); it answers
 * "not_configured" without a key.
 */
export const resendMandateMailer: MandateMailer = (mail) => sendMandateEmail(mail);

const HEADERS: Record<string, readonly string[]> = {
  business: ["business", "businessname", "client", "name", "company"],
  email: ["email", "e-mail", "mail", "owneremail"],
  country: ["country"],
  language: ["language", "locale", "lang"],
};
const norm = (h: string) => h.toLowerCase().replace(/[\s_.]/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ImportResult {
  requested: number;
  /** Rows left out, each with why — never guessed. */
  skipped: { row: number; why: "email" | "business" | "already_asked" }[];
  emails: { sent: number; not_configured: number; failed: number };
}

/**
 * §7.6: "A firm must be able to add 40 clients in one session." One CSV
 * (business, email; country and language optional), one evidence reference
 * and one scope list for the batch — each client a request, emailed in its
 * language. A client already asked and not yet answered isn't asked twice.
 */
export async function importClients(args: {
  userId: string;
  csv: string;
  scopes: readonly string[];
  months?: number;
  evidenceRef: string;
  appUrl: string;
  defaultLocale?: AppLocale;
  mailer?: MandateMailer;
  now?: Date;
}): Promise<ImportResult> {
  const { firm } = await requireFirm(args.userId, ["principal", "manager"]);
  const scopes = cleanScopes(args.scopes);
  const months = args.months ?? DEFAULT_MONTHS;
  addMonths(new Date(), months); // checks the term
  const evidence = args.evidenceRef.trim();
  if (evidence === "")
    throw new MandateError("give the engagement letter's reference for these clients");
  const rows = parseDelimited(args.csv.replace(/^\uFEFF/, "")).filter((r) =>
    r.some((c) => c.trim() !== ""),
  );
  if (rows.length < 2)
    throw new MandateError("the file needs a header row and at least one client");
  if (rows.length - 1 > MAX_IMPORT_ROWS)
    throw new MandateError(`one import takes up to ${MAX_IMPORT_ROWS} clients`, 413);
  const header = rows[0]!.map(norm);
  const col = (role: keyof typeof HEADERS) => header.findIndex((h) => HEADERS[role]!.includes(h));
  const c = {
    business: col("business"),
    email: col("email"),
    country: col("country"),
    language: col("language"),
  };
  if (c.business === -1 || c.email === -1)
    throw new MandateError("the file needs a business name column and an email column");

  const mailer = args.mailer ?? resendMandateMailer;
  const now = args.now ?? new Date();
  const out: ImportResult = {
    requested: 0,
    skipped: [],
    emails: { sent: 0, not_configured: 0, failed: 0 },
  };
  for (const [i, r] of rows.slice(1).entries()) {
    const cell = (n: number) => (n === -1 ? "" : (r[n] ?? "").trim());
    const email = cell(c.email).toLowerCase();
    const business = cell(c.business).slice(0, 120);
    if (!EMAIL.test(email)) {
      out.skipped.push({ row: i + 2, why: "email" });
      continue;
    }
    if (business === "") {
      out.skipped.push({ row: i + 2, why: "business" });
      continue;
    }
    const lang = cell(c.language);
    const locale: AppLocale = isAppLocale(lang) ? lang : (args.defaultLocale ?? "en");
    const country = cell(c.country).toUpperCase();
    const token = randomBytes(24).toString("base64url");
    const [made] = await db
      .insert(mandateRequests)
      .values({
        firm_id: firm.id,
        business_name: business,
        email,
        country: /^[A-Z]{2}$/.test(country) ? country : null,
        locale,
        scopes,
        months,
        evidence_ref: evidence.slice(0, 200),
        token_hash: sha(token),
        created_by_user_id: args.userId,
        expires_at: new Date(now.getTime() + REQUEST_DAYS * 86_400_000).toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: mandateRequests.id });
    if (!made) {
      out.skipped.push({ row: i + 2, why: "already_asked" });
      continue;
    }
    out.requested++;
    const sent = await mailer({
      to: email,
      locale,
      firm: firm.name,
      business,
      link: `${args.appUrl}/mandate/${token}`,
      scopes,
    });
    out.emails[sent]++;
  }
  return out;
}

/** What the client sees before granting: the firm, the business, the scopes, the term. Null when not open. */
export async function requestByToken(token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) return null;
  const [row] = await db
    .select({ request: mandateRequests, firm: { id: firms.id, name: firms.name } })
    .from(mandateRequests)
    .innerJoin(firms, eq(firms.id, mandateRequests.firm_id))
    .where(eq(mandateRequests.token_hash, sha(token)));
  if (!row || row.request.status !== "sent" || Date.parse(row.request.expires_at) <= now.getTime())
    return null;
  return row;
}

/**
 * The client grants from the email. The link proves the address. With no
 * SYB user for it, a business is made for them and they become its owner;
 * an address that already owns a business grants from inside SYB instead
 * (Settings → Firms), where it is signed in and chooses which business.
 */
export async function grantByToken(token: string, now = new Date()) {
  const open = await requestByToken(token, now);
  if (!open) throw new MandateError("that link isn't open any more", 410);
  const { request } = open;
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, request.email), isNull(users.removed_at)))
    .limit(1);
  if (existing)
    throw new MandateError("sign in to SYB with this address and grant it from Settings", 409);

  const s = await bootstrapIntake({
    language: isAppLocale(request.locale) ? request.locale : "en",
  });
  const owner = await createOwner(s.account_id, request.email);
  const m = await grantMandate({
    ownerUserId: owner.id,
    profileId: s.profile_id,
    firmId: request.firm_id,
    scopes: request.scopes,
    months: request.months,
    evidenceRef: request.evidence_ref,
    now,
  });
  await db
    .update(mandateRequests)
    .set({ status: "granted", mandate_id: m.id })
    .where(eq(mandateRequests.id, request.id));
  const session = await openSession(owner);
  return { mandate: m, profile_id: s.profile_id, session };
}

/** An owner signed in to SYB: the requests waiting for their address. */
export async function requestsFor(email: string, now = new Date()) {
  const rows = await db
    .select({ request: mandateRequests, firm: { id: firms.id, name: firms.name } })
    .from(mandateRequests)
    .innerJoin(firms, eq(firms.id, mandateRequests.firm_id))
    .where(and(eq(mandateRequests.email, email.toLowerCase()), eq(mandateRequests.status, "sent")));
  return rows.filter((r) => Date.parse(r.request.expires_at) > now.getTime());
}

/** A signed-in owner grants a waiting request for one of their businesses. */
export async function grantRequest(args: {
  ownerUserId: string;
  ownerEmail: string;
  profileId: string;
  requestId: string;
  now?: Date;
}) {
  const [request] = await db
    .select()
    .from(mandateRequests)
    .where(and(eq(mandateRequests.id, args.requestId), eq(mandateRequests.status, "sent")));
  if (!request || request.email !== args.ownerEmail.toLowerCase())
    throw new MandateError("no such request", 404);
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, args.profileId));
  if (!profile) throw new MandateError("no such business", 404);
  const m = await grantMandate({
    ownerUserId: args.ownerUserId,
    profileId: args.profileId,
    firmId: request.firm_id,
    scopes: request.scopes,
    months: request.months,
    evidenceRef: request.evidence_ref,
    ...(args.now ? { now: args.now } : {}),
  });
  await db
    .update(mandateRequests)
    .set({ status: "granted", mandate_id: m.id })
    .where(eq(mandateRequests.id, request.id));
  return m;
}
