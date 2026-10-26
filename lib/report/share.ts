// Shareable report links — idea 51 (2026-10-26). The owner makes a
// read-only link to their diagnosis report for a partner, an accountant or
// an investor.
//
// The token is the WHOLE credential, like the unsubscribe link's: 32 random
// bytes, base64url, handed out once at creation and never stored — the row
// holds sha256(token) only (as login, resume and unsubscribe tokens do). A
// token is checked for shape before any query, looked up by its hash, and
// the stored hash is compared again in constant time (lib/core/secret-
// compare). Every way a link fails — unknown, revoked, expired, malformed —
// answers the SAME null, so the page can't be used to tell them apart.
//
// SNAPSHOT, not live (the conservative choice for a link that leaves the
// owner's hands): a link is pinned to the report that was current when it
// was made. Its facts come from that report's frozen snapshot, and the
// superseded history shown with it stops at the moment the link was made,
// so a later report, a correction or a newly connected source never
// reaches a reader the link was sent to earlier. To share something newer,
// the owner makes a new link.
//
// What a reader sees is the report minus everything that isn't theirs to
// see (sharedView): no profile or snapshot id, no generation cost, none of
// the owner's own answers to the recommendations, no links back into the
// account, only the facts the report itself cites, and never a personal
// field (an address, a person's name, an email or a phone). Customer
// contacts are never read here at all.
//
// Creating and revoking are owner actions and go into the append-only
// decision log (rule 7) — the share row's id and a hash, never the token.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, diagnosisReports, reportShares } from "../../db/schema";
import { secretMatches } from "../core/secret-compare";
import type { FactHistory } from "../profile/factsheet";
import { reportForProfile } from "./service";
import type { ReportView } from "./service";

export class ShareError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ShareError";
    this.status = status;
  }
}

/** The expiries an owner may choose, in days. Seven is the default. */
export const SHARE_DAYS = [7, 30] as const;
export type ShareDays = (typeof SHARE_DAYS)[number];
export const DEFAULT_SHARE_DAYS: ShareDays = 7;

export function isShareDays(v: unknown): v is ShareDays {
  return typeof v === "number" && (SHARE_DAYS as readonly number[]).includes(v);
}

/** How many links one business may hold open at once — a list, not a mailing tool. */
export const MAX_ACTIVE_SHARES = 20;

const TOKEN_BYTES = 32;
/** A token as minted: 43 base64url characters. Anything else is refused before a query. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const shareTokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export type ShareStatus = "active" | "expired" | "revoked";

/** Pure: a link's state at `now`. Revoked wins over expired — it was the owner's act. */
export function shareStatus(
  row: { expires_at: string; revoked_at: string | null },
  now: Date = new Date(),
): ShareStatus {
  if (row.revoked_at !== null) return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "active";
}

export interface ShareListItem {
  id: string;
  report_id: string;
  report_generated_at: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  status: ShareStatus;
}

export function hashShareDecision(p: {
  kind: "report_share" | "report_share_revoke";
  share_id: string;
  report_id: string;
  expires_at: string;
  at: string;
}): string {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}

/**
 * Make a link to the business's CURRENT report. Returns the token once —
 * the caller builds the URL from it and it is never readable again.
 */
export async function createShare(args: {
  accountId: string;
  profileId: string;
  userId: string | null;
  days?: ShareDays;
  now?: Date;
}): Promise<{ token: string; share: ShareListItem }> {
  const now = args.now ?? new Date();
  const days = args.days ?? DEFAULT_SHARE_DAYS;
  if (!isShareDays(days)) throw new ShareError("a link lasts 7 or 30 days", 400);

  const [report] = await db
    .select({ id: diagnosisReports.id, generated_at: diagnosisReports.generated_at })
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, args.profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (!report) throw new ShareError("there's no report to share yet");

  const active = await listShares({ accountId: args.accountId, profileId: args.profileId, now });
  if (active.filter((s) => s.status === "active").length >= MAX_ACTIVE_SHARES) {
    throw new ShareError(`revoke a link first — at most ${MAX_ACTIVE_SHARES} can be open at once`);
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(reportShares)
      .values({
        account_id: args.accountId,
        profile_id: args.profileId,
        report_id: report.id,
        token_hash: shareTokenHash(token),
        created_by: args.userId,
        created_at: createdAt,
        expires_at: expiresAt,
      })
      .returning();
    if (!inserted) throw new ShareError("the link could not be made", 500);
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "report_share",
      ref_id: inserted.id,
      payload_hash: hashShareDecision({
        kind: "report_share",
        share_id: inserted.id,
        report_id: report.id,
        expires_at: expiresAt,
        at: createdAt,
      }),
    });
    return inserted;
  });

  // Ids only: never the token or its hash.
  console.log(
    JSON.stringify({
      event: "report_share_created",
      account_id: args.accountId,
      share_id: row.id,
      days,
    }),
  );
  return {
    token,
    share: {
      id: row.id,
      report_id: row.report_id,
      report_generated_at: report.generated_at,
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      last_viewed_at: row.last_viewed_at,
      view_count: row.view_count,
      status: shareStatus(row, now),
    },
  };
}

/** Every link this business has made, newest first, with its state. Never a hash. */
export async function listShares(args: {
  accountId: string;
  profileId: string;
  now?: Date;
}): Promise<ShareListItem[]> {
  const now = args.now ?? new Date();
  const rows = await db
    .select({
      id: reportShares.id,
      report_id: reportShares.report_id,
      report_generated_at: diagnosisReports.generated_at,
      created_at: reportShares.created_at,
      expires_at: reportShares.expires_at,
      revoked_at: reportShares.revoked_at,
      last_viewed_at: reportShares.last_viewed_at,
      view_count: reportShares.view_count,
    })
    .from(reportShares)
    .innerJoin(diagnosisReports, eq(diagnosisReports.id, reportShares.report_id))
    .where(
      and(eq(reportShares.account_id, args.accountId), eq(reportShares.profile_id, args.profileId)),
    )
    .orderBy(desc(reportShares.created_at))
    .limit(50);
  // ISO 8601 out, whatever shape the driver hands back, so every browser reads the dates.
  const iso = (v: string) => new Date(v).toISOString();
  return rows.map((r) => ({
    ...r,
    report_generated_at: iso(r.report_generated_at),
    created_at: iso(r.created_at),
    expires_at: iso(r.expires_at),
    revoked_at: r.revoked_at === null ? null : iso(r.revoked_at),
    last_viewed_at: r.last_viewed_at === null ? null : iso(r.last_viewed_at),
    status: shareStatus(r, now),
  }));
}

/**
 * Revoke a link now. Idempotent: revoking a revoked link changes nothing
 * and logs nothing. A share id that isn't this business's is refused the
 * same way as one that doesn't exist.
 */
export async function revokeShare(args: {
  accountId: string;
  profileId: string;
  shareId: string;
  now?: Date;
}): Promise<{ revoked: boolean }> {
  const at = (args.now ?? new Date()).toISOString();
  const owned = and(
    eq(reportShares.id, args.shareId),
    eq(reportShares.account_id, args.accountId),
    eq(reportShares.profile_id, args.profileId),
  );
  const [exists] = await db.select({ id: reportShares.id }).from(reportShares).where(owned);
  if (!exists) throw new ShareError("no such link", 404);

  const first = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reportShares)
      .set({ revoked_at: at })
      .where(and(owned, isNull(reportShares.revoked_at)))
      .returning();
    if (!row) return false;
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "report_share_revoke",
      ref_id: row.id,
      payload_hash: hashShareDecision({
        kind: "report_share_revoke",
        share_id: row.id,
        report_id: row.report_id,
        expires_at: row.expires_at,
        at,
      }),
    });
    return true;
  });
  console.log(
    JSON.stringify({
      event: "report_share_revoked",
      account_id: args.accountId,
      share_id: args.shareId,
      first,
    }),
  );
  return { revoked: first };
}

interface LiveShare {
  id: string;
  account_id: string;
  profile_id: string;
  report_id: string;
  created_at: string;
}

/**
 * The link behind a token, or null — for unknown, malformed, revoked and
 * expired alike. Counts the view on a live link.
 */
export async function resolveShare(
  token: string,
  now: Date = new Date(),
): Promise<LiveShare | null> {
  if (typeof token !== "string" || !SHARE_TOKEN_RE.test(token)) return null;
  const hash = shareTokenHash(token);
  const [row] = await db
    .select({
      id: reportShares.id,
      account_id: reportShares.account_id,
      profile_id: reportShares.profile_id,
      report_id: reportShares.report_id,
      token_hash: reportShares.token_hash,
      created_at: reportShares.created_at,
      expires_at: reportShares.expires_at,
      revoked_at: reportShares.revoked_at,
    })
    .from(reportShares)
    .where(eq(reportShares.token_hash, hash));
  if (!row || !secretMatches(hash, row.token_hash)) return null;
  if (shareStatus(row, now) !== "active") return null;
  await db
    .update(reportShares)
    .set({
      last_viewed_at: now.toISOString(),
      view_count: sql`${reportShares.view_count} + 1`,
    })
    .where(eq(reportShares.id, row.id));
  return {
    id: row.id,
    account_id: row.account_id,
    profile_id: row.profile_id,
    report_id: row.report_id,
    created_at: row.created_at,
  };
}

/* ── what a reader sees ── */

/**
 * Facts a reader never sees, even when the report cites them: anything
 * that can name or locate a person. Matched on the key's segments, so an
 * entity field ("suppliers.<id>.email") is caught as surely as a scalar.
 */
const PERSONAL_SEGMENT =
  /(^|\.)(postal_address|address|public_face|email|e_mail|phone|mobile|contact_name|owner_name|full_name|first_name|last_name|tax_id|personal_id|iban|bank_account)(\.|$)/;

export function isPersonalKey(key: string): boolean {
  return PERSONAL_SEGMENT.test(key);
}

export interface SharedReport {
  /** The report's own id, which the owner sees as "specimen …" — opens nothing on its own. */
  id: string;
  generated_at: string;
  summary: string;
  completeness: number;
  unit_economics: ReportView["unit_economics"];
  findings: ReportView["findings"];
  /** The recommendations without the owner's answers to them. */
  recommendations: (Omit<ReportView["recommendations"][number], "status" | "rejection_reason"> & {
    status: "proposed";
    rejection_reason: null;
  })[];
  data_gaps: ReportView["data_gaps"];
  trading_hours: ReportView["trading_hours"];
  fact_map: ReportView["fact_map"];
  history: FactHistory;
  prior: { id: string; generated_at: string; unit_economics: ReportView["unit_economics"] } | null;
  /** When the link was made — the footer's "shared snapshot of …". */
  shared_at: string;
}

/** Every string in a value, however deep — what the report itself refers to. */
function stringsIn(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
}

/**
 * Pure: the owner's report as a reader may see it. Only facts the report
 * cites (findings' evidence, the economics' inputs, the assumptions) and
 * never a personal one; history only for those facts and only up to the
 * moment the link was made.
 */
export function sharedView(report: ReportView, sharedAt: string): SharedReport {
  const cited = new Set<string>();
  stringsIn(
    {
      unit_economics: report.unit_economics,
      findings: report.findings,
      recommendations: report.recommendations.map((r) => ({ ...r, rejection_reason: null })),
      trading_hours: report.trading_hours,
      prior: report.prior?.unit_economics ?? null,
    },
    cited,
  );
  // The masthead names the business and its platform, as the owner's report does.
  for (const k of ["identity.business_name", "identity.legal_name", "presence.platforms"]) {
    cited.add(k);
  }
  // A cited entity field reads by its entity's name ("Bud Vase Trio · price"), so the name travels too.
  for (const key of [...cited]) {
    const entity = /^([a-z_]+\.[0-9a-f-]{36})\.[a-z_]+$/.exec(key);
    if (entity) cited.add(`${entity[1]}.name`);
  }
  const visible = (key: string) => cited.has(key) && !isPersonalKey(key);

  const factMap: ReportView["fact_map"] = {};
  for (const [key, fact] of Object.entries(report.fact_map)) {
    if (visible(key)) factMap[key] = fact;
  }
  const cutoff = new Date(sharedAt).getTime();
  const history: FactHistory = {};
  for (const [key, lines] of Object.entries(report.history)) {
    if (!visible(key)) continue;
    const kept = lines.filter((h) => new Date(h.superseded_at).getTime() <= cutoff);
    if (kept.length > 0) history[key] = kept;
  }

  return {
    id: report.id,
    generated_at: report.generated_at,
    summary: report.summary,
    completeness: report.completeness,
    unit_economics: report.unit_economics,
    findings: report.findings,
    recommendations: report.recommendations.map((r) => {
      const { status: _status, rejection_reason: _reason, ...rest } = r;
      void _status;
      void _reason;
      return { ...rest, status: "proposed" as const, rejection_reason: null };
    }),
    data_gaps: report.data_gaps,
    trading_hours: report.trading_hours,
    fact_map: factMap,
    history,
    prior: report.prior
      ? {
          id: "",
          generated_at: report.prior.generated_at,
          unit_economics: report.prior.unit_economics,
        }
      : null,
    shared_at: sharedAt,
  };
}

/** The page's one read: a live token's frozen report, or null for every kind of dead link. */
export async function viewSharedReport(
  token: string,
  now: Date = new Date(),
): Promise<SharedReport | null> {
  const share = await resolveShare(token, now);
  if (!share) return null;
  // The pinned report, read through the same view the owner gets, scoped to its own profile.
  const report = await reportForProfile(share.profile_id, share.report_id);
  if (!report) return null;
  return sharedView(report, share.created_at);
}
