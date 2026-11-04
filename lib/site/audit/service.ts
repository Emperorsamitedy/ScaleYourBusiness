// The site audit's service — Phase 5 Session C (P5-11..13).
//
// One run: walk the owner's site from its home page by reading pages
// (walk.ts, rule 30), pick the home page and up to four key pages, ask
// PageSpeed Insights about them at mobile and desktop (pagespeed.ts, GET
// only), turn the measurements into measured SiteFindings against stated
// thresholds (findings.ts), store the run (site_audits), and write one fact,
// presence.site_audit, that the diagnosis and the report cite.
//
// Caps. PageSpeed calls are capped per site (origin) over a rolling seven
// days, counted from the stored rows — what was spent is what is counted,
// retries included — and logged like every other external read. A run is
// allowed once per COOLDOWN per business, and one at a time. No model is
// called anywhere in this session.
//
// L-4c: the refusals, notes and failure reasons are the "siteWords"
// catalogue's English (lib/site/say.ts), stored as English and said again
// in the reader's language by lib/site/localize.ts.

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../../db";
import { withAdvisoryLock } from "../../../db/advisory-lock";
import { businessProfiles, siteAudits } from "../../../db/schema";
import { displaySourceKind } from "../../connectors/measured";
import { confidence } from "../../core/confidence";
import type { Field } from "../../core/field";
import { createField } from "../../core/field";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import { logSafeError } from "../../core/log-safe";
import { format, money } from "../../core/money";
import type { DiagnosisFinding } from "../../diagnosis/findings";
import { pagespeedApiKey } from "../../env";
import { readCurrentField, writeField } from "../../profile/field-store";
import type { PageFetcher } from "../fetch";
import { siteEnglish } from "../say";
import { livePageFetcher } from "../fetch";
import type { PlatformVerdict } from "../platform";
import type { OwnerSiteFigures, SiteFinding } from "./findings";
import { SITE_AUDIT_KEY, auditSummary, siteFindings, toDiagnosisFindings } from "./findings";
import type { PageSpeedFetch, PageSpeedResult, Strategy } from "./pagespeed";
import { PAGESPEED_CAPS, PageSpeedError, createPageSpeedClient } from "./pagespeed";
import type { AuditedPageView, SiteAuditView } from "./view";
import { NEVER_LINES, NOT_BUILT } from "./view";
import type { BrokenLink, PurchasePath, WalkResult } from "./walk";
import { SiteWalkError, keyPages, walkSite } from "./walk";

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
/** "5 Oct 2026": the day a figure is as of, in words. */
const dayWords = (iso: string) => DAY_FMT.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

const EN = siteEnglish();

export const WEBSITE_KEY = "presence.website_url";

export const AUDIT_CAPS = {
  /** One run per business this often — the owner's own server is being read. */
  cooldown_ms: 60 * 60 * 1000,
  /** The window the weekly PageSpeed cap counts over. */
  week_ms: 7 * 86_400_000,
} as const;

const WEEK_MS = AUDIT_CAPS.week_ms;

export type SiteAuditOutcome =
  | { status: "read"; audit: SiteAuditView }
  | { status: "failed"; why: string }
  | { status: "refused"; why: string };

type AuditRow = typeof siteAudits.$inferSelect;

/** The site as the owner gave it, or null. */
async function ownerSite(profileId: string): Promise<string | null> {
  const field = await readCurrentField<string>(profileId, WEBSITE_KEY);
  if (!field || field.status !== "answered" || typeof field.value !== "string") return null;
  const raw = field.value.trim();
  if (raw === "") return null;
  try {
    // "shop.example" and "https://shop.example" are the same home page: https://shop.example/
    return new URL(raw.includes("://") ? raw : `https://${raw}`).href;
  } catch {
    return null;
  }
}

/** PageSpeed calls made for this site in the seven days before `now`. */
export async function callsThisWeek(
  origin: string,
  now: Date,
): Promise<{ used: number; oldest: string | null }> {
  const rows = await db
    .select({ calls: siteAudits.pagespeed_calls, ran_at: siteAudits.ran_at })
    .from(siteAudits)
    .where(
      and(
        eq(siteAudits.origin, origin),
        gte(siteAudits.ran_at, new Date(now.getTime() - WEEK_MS).toISOString()),
      ),
    );
  const spent = rows.filter((r) => r.calls > 0);
  const oldest = spent.map((r) => new Date(r.ran_at).getTime()).sort((a, b) => a - b)[0];
  return {
    used: spent.reduce((sum, r) => sum + r.calls, 0),
    oldest: oldest === undefined ? null : new Date(oldest).toISOString(),
  };
}

/* ── the owner's own figures, for the € line ── */

const valueBearing = (f: Field<unknown> | null): f is Field<unknown> =>
  f !== null && (f.status === "answered" || f.status === "inferred") && f.value !== null;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * The owner's own monthly visits, orders and revenue — measured by their
 * connectors or stated by them, never borrowed (rule 25) — or what is
 * missing, by name.
 */
export async function ownerSiteFigures(
  profileId: string,
): Promise<OwnerSiteFigures | { missing: string }> {
  const [sessions, orders, revenue] = await Promise.all([
    readCurrentField<unknown>(profileId, "presence.monthly_sessions"),
    readCurrentField<unknown>(profileId, "revenue.order_count_monthly"),
    readCurrentField<unknown>(profileId, "revenue.monthly_revenue"),
  ]);
  const missing: string[] = [];
  const s = valueBearing(sessions) ? asNumber(sessions.value) : null;
  const o = valueBearing(orders) ? asNumber(orders.value) : null;
  const rv = valueBearing(revenue)
    ? (revenue.value as { amount_minor?: unknown; currency?: unknown })
    : null;
  const r =
    rv && Number.isSafeInteger(rv.amount_minor) && typeof rv.currency === "string"
      ? { amount_minor: rv.amount_minor as number, currency: rv.currency }
      : null;
  if (s === null) missing.push(EN("euro.missing.visits"));
  if (o === null) missing.push(EN("euro.missing.orders"));
  if (r === null) missing.push(EN("euro.missing.revenue"));
  if (s === null || o === null || r === null)
    return { missing: EN("euro.missing.list", { list: missing.join(", ") }) };
  if (o <= 0) return { missing: EN("euro.missing.zero") };
  const fields = [
    ["visits", sessions],
    ["orders", orders],
    ["revenue", revenue],
  ] as const;
  const kinds = fields.map(([, f]) => displaySourceKind((f as Field<unknown>).source));
  const allMeasured = kinds.every((k) => k === "connector");
  const latest = fields
    .map(([, f]) => (f as Field<unknown>).observed_at)
    .sort()
    .at(-1) as string;
  return {
    sessions_per_month: s,
    orders_per_month: o,
    aov_minor: Math.round(r.amount_minor / o),
    currency: r.currency,
    basis: allMeasured ? "measured" : "stated",
    window: EN(allMeasured ? "euro.window.measured" : "euro.window.stated", {
      day: dayWords(latest),
    }),
    as_of: latest.slice(0, 10),
    sources: fields.map(
      ([name, f], i) =>
        `${name}: ${kinds[i] === "connector" ? "measured" : kinds[i]?.replace(/_/g, " ")} (${f === sessions ? "presence.monthly_sessions" : f === orders ? "revenue.order_count_monthly" : "revenue.monthly_revenue"})`,
    ),
  };
}

/* ── the run ── */

export interface RunSiteAuditArgs {
  profileId: string;
  fetcher?: PageFetcher;
  pagespeedFetch?: PageSpeedFetch;
  /** Overrides PAGESPEED_API_KEY; null means no key, so speed isn't measured. */
  apiKey?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

/** Run the audit for one business. Reads only — the site, and Google's public API. */
export async function runSiteAudit(args: RunSiteAuditArgs): Promise<SiteAuditOutcome> {
  const now = args.now ?? new Date();
  const home = await ownerSite(args.profileId);
  if (!home) return { status: "refused", why: EN("audit.noSite") };
  let origin: string;
  try {
    origin = new URL(home).origin;
  } catch {
    return { status: "refused", why: EN("audit.badSite") };
  }
  const [last] = await db
    .select({ ran_at: siteAudits.ran_at })
    .from(siteAudits)
    .where(eq(siteAudits.profile_id, args.profileId))
    .orderBy(desc(siteAudits.ran_at))
    .limit(1);
  if (last && now.getTime() - new Date(last.ran_at).getTime() < AUDIT_CAPS.cooldown_ms) {
    const from = new Date(new Date(last.ran_at).getTime() + AUDIT_CAPS.cooldown_ms);
    return {
      status: "refused",
      why: EN("audit.cooldown", { time: from.toISOString().slice(11, 16) }),
    };
  }
  return withAdvisoryLock(
    `site-audit:${args.profileId}`,
    () => runLocked(args, home, origin, now),
    () => ({ status: "refused", why: EN("audit.running") }),
  );
}

async function accountOf(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? null;
}

interface SpeedRun {
  results: PageSpeedResult[];
  errors: Map<string, string>;
  calls: number;
  note: string | null;
}

/** What /site says when no PAGESPEED_API_KEY is set. */
export const NO_KEY_NOTE = EN("pagespeed.noKey");

async function measure(
  pages: { url: string }[],
  budget: number,
  args: RunSiteAuditArgs,
  keyed: string | null,
  now: Date,
): Promise<SpeedRun> {
  const tasks: { url: string; strategy: Strategy }[] = [];
  for (const strategy of ["mobile", "desktop"] as const)
    for (const p of pages) tasks.push({ url: p.url, strategy });
  const planned = tasks.length;
  const run = tasks.slice(0, Math.max(0, budget));
  const client = createPageSpeedClient({
    apiKey: keyed,
    maxRequests: Math.max(0, budget),
    ...(args.pagespeedFetch ? { fetch: args.pagespeedFetch } : {}),
    ...(args.sleep ? { sleep: args.sleep } : {}),
    now: () => now,
  });
  const results: PageSpeedResult[] = [];
  const errors = new Map<string, string>();
  let stopped: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < run.length && stopped === null) {
      const task = run[next++] as { url: string; strategy: Strategy };
      try {
        results.push(await client.run(task.url, task.strategy));
      } catch (error) {
        const why = error instanceof PageSpeedError ? error.message : EN("pagespeed.failedBare");
        if (error instanceof PageSpeedError && error.kind === "quota") stopped = why;
        else errors.set(`${task.strategy}:${task.url}`, why);
      }
    }
  };
  await Promise.all(Array.from({ length: PAGESPEED_CAPS.concurrency }, worker));
  let note: string | null = null;
  if (stopped !== null) {
    note = EN("pagespeed.stopped", {
      reason: stopped,
      made: String(results.length),
      planned: String(planned),
    });
  } else if (run.length < planned) {
    note =
      run.length === 0
        ? EN("pagespeed.weekUsed", { cap: String(PAGESPEED_CAPS.max_calls_per_site_per_week) })
        : EN("pagespeed.short", { made: String(run.length), planned: String(planned) });
  }
  return { results, errors, calls: client.requests, note };
}

async function runLocked(
  args: RunSiteAuditArgs,
  home: string,
  origin: string,
  now: Date,
): Promise<SiteAuditOutcome> {
  const accountId = await accountOf(args.profileId);
  const fetcher = args.fetcher ?? livePageFetcher;
  let walk: WalkResult;
  try {
    walk = await walkSite(home, fetcher);
  } catch (error) {
    const why =
      error instanceof SiteWalkError || error instanceof Error
        ? EN("audit.homeUnreadable", { reason: error.message })
        : EN("audit.homeUnreadableBare");
    console.error(
      JSON.stringify({
        event: "site_audit_failed",
        account_id: accountId,
        profile_id: args.profileId,
        ...logSafeError(error),
      }),
    );
    await db.insert(siteAudits).values({
      profile_id: args.profileId,
      status: "failed",
      ran_at: now.toISOString(),
      url: home,
      origin,
      reason: why,
    });
    return { status: "failed", why };
  }

  const { used } = await callsThisWeek(origin, now);
  const budget = PAGESPEED_CAPS.max_calls_per_site_per_week - used;
  const key = args.apiKey === undefined ? pagespeedApiKey() : args.apiKey;
  const picks = keyPages(walk, PAGESPEED_CAPS.max_pages);
  // Google's keyless quota is zero (checked against the live API 2026-10-28:
  // every keyless call answers 429, "limit value 0"), so without a key the
  // audit asks Google nothing and says why; the path is still walked.
  const speed: SpeedRun =
    key === null
      ? { results: [], errors: new Map(), calls: 0, note: NO_KEY_NOTE }
      : await measure(picks, budget, args, key, now);
  const figures = await ownerSiteFigures(args.profileId);
  const findings = siteFindings({
    walk,
    speed: speed.results,
    figures,
    measured_at: now.toISOString(),
  });

  const pages: AuditedPageView[] = walk.pages.map((p) => ({
    url: p.url,
    role: p.role,
    label: p.label,
    clicks: p.clicks,
    status: p.status,
    error: p.error,
    price_first_screen: p.price_first_screen,
    forms: p.forms,
    mobile: speed.results.find((r) => r.page_url === p.url && r.strategy === "mobile") ?? null,
    desktop: speed.results.find((r) => r.page_url === p.url && r.strategy === "desktop") ?? null,
    speed_error:
      speed.errors.get(`mobile:${p.url}`) ?? speed.errors.get(`desktop:${p.url}`) ?? null,
  }));

  const [row] = await db
    .insert(siteAudits)
    .values({
      profile_id: args.profileId,
      status: "read",
      ran_at: now.toISOString(),
      url: home,
      origin,
      platform: walk.platform,
      pages: pages as unknown as Record<string, unknown>[],
      path: { ...walk.path, broken: walk.broken, refused: walk.refused } as unknown as Record<
        string,
        unknown
      >,
      findings: findings as unknown as Record<string, unknown>[],
      pagespeed_calls: speed.calls,
      page_reads: walk.reads,
      pagespeed_keyed: key !== null,
      pagespeed_note: speed.note,
    })
    .returning();
  if (!row) throw new Error("site audit insert failed");

  const measuredPages = new Set(speed.results.map((r) => r.page_url)).size;
  await writeField(
    args.profileId,
    createField<SiteAuditFact>({
      id: fieldId(SITE_AUDIT_KEY),
      value: {
        value: auditSummary(findings, measuredPages),
        audit_id: row.id,
        ran_at: row.ran_at,
        findings: findings.map((f) => ({
          code: f.code,
          severity: f.severity,
          page_url: f.page_url,
        })),
      },
      status: "answered",
      confidence: confidence(measuredPages > 0 ? 0.8 : 0.6),
      source: { kind: "web_research", researched_url: walk.home },
      observed_at: isoDateTime(now.toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
      note: `Measured by Google PageSpeed Insights v5 (${measuredPages} page${measuredPages === 1 ? "" : "s"}, mobile and desktop) and by reading ${walk.reads} page${walk.reads === 1 ? "" : "s"} of the site; nothing was submitted.`,
    }),
  );

  console.log(
    JSON.stringify({
      event: "site_audit",
      account_id: accountId,
      profile_id: args.profileId,
      origin,
      page_reads: walk.reads,
      pagespeed_calls: speed.calls,
      pagespeed_keyed: key !== null,
      findings: findings.length,
    }),
  );
  return { status: "read", audit: await viewOf(row, now) };
}

/** What presence.site_audit holds: a sentence the diagnosis reads, and the audit it came from. */
export interface SiteAuditFact {
  value: string;
  audit_id: string;
  ran_at: string;
  findings: { code: string; severity: string; page_url: string }[];
}

/* ── reading ── */

async function viewOf(row: AuditRow, now: Date): Promise<SiteAuditView> {
  const { used, oldest } = await callsThisWeek(row.origin, now);
  const cap = PAGESPEED_CAPS.max_calls_per_site_per_week;
  const path = row.path as unknown as PurchasePath & {
    broken?: BrokenLink[];
    refused?: SiteAuditView["refused"];
  };
  return {
    id: row.id,
    ran_at: new Date(row.ran_at).toISOString(),
    url: row.url,
    platform: (row.platform as PlatformVerdict | null) ?? null,
    pages: row.pages as unknown as AuditedPageView[],
    path: {
      kind: path.kind,
      steps: path.steps ?? [],
      clicks: path.clicks ?? null,
      notes: path.notes ?? [],
    },
    broken: path.broken ?? [],
    refused: path.refused ?? [],
    findings: row.findings as unknown as SiteFinding[],
    page_reads: row.page_reads,
    pagespeed: {
      calls: row.pagespeed_calls,
      keyed: row.pagespeed_keyed,
      note: row.pagespeed_note,
      weekly_cap: cap,
      used_this_week: used,
      next_from:
        used >= cap && oldest !== null
          ? new Date(new Date(oldest).getTime() + WEEK_MS).toISOString()
          : null,
    },
    never: NEVER_LINES,
    not_built: NOT_BUILT,
  };
}

/** The latest stored audit for a business, or null. */
export async function latestSiteAudit(
  profileId: string,
  now = new Date(),
): Promise<SiteAuditView | null> {
  const [row] = await db
    .select()
    .from(siteAudits)
    .where(and(eq(siteAudits.profile_id, profileId), eq(siteAudits.status, "read")))
    .orderBy(desc(siteAudits.ran_at))
    .limit(1);
  return row ? viewOf(row, now) : null;
}

/** The latest failed run, when it is newer than the latest good one. */
export async function lastSiteAuditFailure(
  profileId: string,
): Promise<{ at: string; reason: string } | null> {
  const [row] = await db
    .select()
    .from(siteAudits)
    .where(eq(siteAudits.profile_id, profileId))
    .orderBy(desc(siteAudits.ran_at))
    .limit(1);
  return row && row.status === "failed"
    ? { at: new Date(row.ran_at).toISOString(), reason: row.reason ?? EN("audit.failed") }
    : null;
}

/* ── into the report (P5-13) ── */

const fmt = (minor: number, currency: string) => format(money(minor, currency));

/**
 * The measured site findings for a report, from the audit the snapshot's
 * presence.site_audit fact names — so a report reproduces from its snapshot.
 * Empty when the snapshot holds no audit fact or the audit is gone.
 */
export async function siteFindingsForReport(
  auditFact: Field<unknown> | undefined,
  profileId: string,
): Promise<DiagnosisFinding[]> {
  const value = auditFact?.value as Partial<SiteAuditFact> | null | undefined;
  if (!value || typeof value.audit_id !== "string") return [];
  const [row] = await db
    .select()
    .from(siteAudits)
    .where(and(eq(siteAudits.id, value.audit_id), eq(siteAudits.profile_id, profileId)));
  if (!row || row.status !== "read") return [];
  return toDiagnosisFindings(row.findings as unknown as SiteFinding[], fmt);
}
