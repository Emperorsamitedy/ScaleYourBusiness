// Phase 5 Session C — P5-11..13 as tests, the database half: a run is
// stored with its provenance, the weekly per-site PageSpeed cap is counted
// from what was spent, the keyless shared quota is recorded and said, a
// home page that can't be read is a failed row with its reason, the audit
// writes one fact the report cites, and the report carries the measured
// findings from the audit its snapshot names. No network: the page reader
// and PageSpeed are both fakes, and the global fetch is sealed.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  diagnosisReports,
  fieldRecords,
  intakeEvents,
  profileSnapshots,
  siteAudits,
  snapshotRecords,
} from "../../../db/schema";
import { createField } from "../../core/field";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import { bootstrapIntake } from "../../intake/service";
import type { DiagnosisLlm } from "../../diagnosis/findings";
import type { RecommendationsLlm } from "../../diagnosis/recommendations";
import { readCurrentField, writeField } from "../../profile/field-store";
import { generateReport } from "../../report/service";
import { ensureSnapshot, readSnapshot } from "../../profile/snapshot";
import { SITE_AUDIT_KEY } from "./findings";
import { PAGESPEED_CAPS } from "./pagespeed";
import { FAKE_PAGESPEED_KEY, fakePageSpeed } from "./pagespeed-fake";
import type { SiteAuditFact } from "./service";
import {
  AUDIT_CAPS,
  callsThisWeek,
  latestSiteAudit,
  lastSiteAuditFailure,
  ownerSiteFigures,
  runSiteAudit,
  siteFindingsForReport,
} from "./service";
import { SHOP_PAGES, shopFetcher } from "./shop-fixture";

const created: { account_id: string; profile_id: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`no network in the site audit tests (refused: ${String(input)})`);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(siteAudits).where(inArray(siteAudits.profile_id, ids));
    await db.delete(diagnosisReports).where(inArray(diagnosisReports.profile_id, ids));
    const snaps = await db
      .select({ id: profileSnapshots.id })
      .from(profileSnapshots)
      .where(inArray(profileSnapshots.profile_id, ids));
    if (snaps.length > 0) {
      await db.delete(snapshotRecords).where(
        inArray(
          snapshotRecords.snapshot_id,
          snaps.map((s) => s.id),
        ),
      );
      await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    }
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A business whose site is the fixture shop, moved to its own host so the weekly cap is its own. */
async function business(host: string) {
  const s = await bootstrapIntake();
  created.push(s);
  const origin = `https://${host}`;
  const pages = Object.fromEntries(
    Object.entries(SHOP_PAGES).map(([url, html]) => [
      url.replace("https://audit-shop.example", origin),
      html,
    ]),
  );
  await put(s.profile_id, "presence.website_url", host);
  return { ...s, origin, fetcher: shopFetcher(pages) };
}

const slowPhone = {
  lcp_ms: 5200,
  cls: 0.05,
  tbt_ms: 150,
  page_bytes: 2_400_000,
  performance: 0.48,
  contrast_failures: 2,
  tap_target_failures: 0,
  field: { lcp_ms: 4800, cls: 0.04, inp_ms: 160 },
};

describe("P5-11 — a run, stored with its provenance", () => {
  it("measures the home page and its key pages at both widths, and stores every number's source", async () => {
    const b = await business(`audit-${crypto.randomUUID().slice(0, 8)}.example`);
    const psi = fakePageSpeed({
      key: FAKE_PAGESPEED_KEY,
      pages: { [`${b.origin}/`]: { mobile: slowPhone } },
    });
    const now = new Date("2026-10-27T09:00:00Z");
    const outcome = await runSiteAudit({
      profileId: b.profile_id,
      fetcher: b.fetcher,
      pagespeedFetch: psi.fetch,
      apiKey: FAKE_PAGESPEED_KEY,
      now,
    });
    expect(outcome.status).toBe("read");
    if (outcome.status !== "read") return;
    const audit = outcome.audit;
    // Home, product, cart, contact, category — five pages, two strategies.
    expect(psi.calls).toHaveLength(10);
    expect(psi.calls.every((c) => c.init.method === "GET")).toBe(true);
    expect(audit.pagespeed).toMatchObject({
      calls: 10,
      keyed: true,
      used_this_week: 10,
      note: null,
    });
    const home = audit.pages.find((p) => p.role === "home");
    expect(home?.mobile?.field?.lcp_ms?.p75).toBe(4800);
    expect(home?.mobile?.provenance).toMatchObject({ source: "pagespeed_insights", keyed: true });
    expect(home?.desktop).not.toBeNull();
    expect(audit.platform?.platform).toBe("shopify");
    expect(audit.findings[0]).toMatchObject({
      code: "lcp_slow",
      severity: "high",
      kind: "measured",
    });
    expect(audit.findings.find((f) => f.code === "lcp_slow")?.euro).toMatchObject({
      computed: false,
    });
    // The checkout entry was counted, never opened.
    expect(b.fetcher.asked.some((u) => /checkout|cart\/add|login/.test(u))).toBe(false);
    expect(audit.path.clicks).toBe(4);

    // One fact the diagnosis reads and the report cites, naming the audit.
    const fact = await readCurrentField<SiteAuditFact>(b.profile_id, SITE_AUDIT_KEY);
    expect(fact?.source).toEqual({ kind: "web_research", researched_url: `${b.origin}/` });
    expect(fact?.value?.audit_id).toBe(audit.id);
    expect(fact?.value?.value).toMatch(/^Site audit \(measured\)/);
    expect(fact?.note).toMatch(/nothing was submitted/);

    expect((await latestSiteAudit(b.profile_id, now))?.id).toBe(audit.id);
  });

  it("caps PageSpeed calls per site per week, counted from what was spent, and says so", async () => {
    const b = await business(`audit-${crypto.randomUUID().slice(0, 8)}.example`);
    const psi = fakePageSpeed();
    const t0 = new Date("2026-10-20T09:00:00Z");
    const run = (at: Date) =>
      runSiteAudit({
        profileId: b.profile_id,
        fetcher: b.fetcher,
        pagespeedFetch: psi.fetch,
        apiKey: null,
        now: at,
      });
    const first = await run(t0);
    expect(first.status === "read" && first.audit.pagespeed.keyed).toBe(false);
    // Inside the cooldown: refused before anything is read.
    const asked = b.fetcher.asked.length;
    const early = await run(new Date(t0.getTime() + 10 * 60_000));
    expect(early).toMatchObject({ status: "refused" });
    expect(b.fetcher.asked.length).toBe(asked);

    const later = (h: number) => new Date(t0.getTime() + h * AUDIT_CAPS.cooldown_ms);
    const second = await run(later(2));
    const third = await run(later(4));
    expect(psi.calls).toHaveLength(PAGESPEED_CAPS.max_calls_per_site_per_week);
    expect(third.status).toBe("read");
    if (third.status !== "read" || second.status !== "read") return;
    expect(third.audit.pagespeed.calls).toBe(0);
    expect(third.audit.pagespeed.note).toMatch(/PageSpeed calls for the site are used/);
    expect(third.audit.pagespeed.next_from).toBe(
      new Date(t0.getTime() + 7 * 86_400_000).toISOString(),
    );
    // The path is still walked without PageSpeed.
    expect(third.audit.path.clicks).toBe(4);
    expect((await callsThisWeek(b.origin, later(4))).used).toBe(20);
    // A week after the first run, its calls fall out of the window.
    expect(
      (await callsThisWeek(b.origin, new Date(t0.getTime() + 7 * 86_400_000 + 1000))).used,
    ).toBe(10);
  });

  it("records a home page that can't be read as a failed run, with its reason", async () => {
    const b = await business(`audit-${crypto.randomUUID().slice(0, 8)}.example`);
    const psi = fakePageSpeed();
    const outcome = await runSiteAudit({
      profileId: b.profile_id,
      fetcher: shopFetcher({}),
      pagespeedFetch: psi.fetch,
      apiKey: null,
    });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(psi.calls).toHaveLength(0);
    expect((await lastSiteAuditFailure(b.profile_id))?.reason).toMatch(/answered 404/);
    expect(await latestSiteAudit(b.profile_id)).toBeNull();
    expect(await readCurrentField(b.profile_id, SITE_AUDIT_KEY)).toBeNull();
  });

  it("refuses, in words, when the profile has no website", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    expect(await runSiteAudit({ profileId: s.profile_id, apiKey: null })).toEqual({
      status: "refused",
      why: "There's no website in your profile to audit — add it to your fact sheet.",
    });
  });
});

describe("P5-13 / rule 25 — the owner's own figures, and the report", () => {
  it("computes € only from the owner's own visits, orders and revenue, and names what's missing", async () => {
    const b = await business(`audit-${crypto.randomUUID().slice(0, 8)}.example`);
    expect(await ownerSiteFigures(b.profile_id)).toEqual({
      missing: "no monthly website visits, monthly orders, monthly revenue of your own",
    });
    await put(b.profile_id, "presence.monthly_sessions", 4000);
    await put(b.profile_id, "revenue.order_count_monthly", 80);
    await put(b.profile_id, "revenue.monthly_revenue", { amount_minor: 360_000, currency: "EUR" });
    const figures = await ownerSiteFigures(b.profile_id);
    expect(figures).toMatchObject({
      sessions_per_month: 4000,
      orders_per_month: 80,
      aov_minor: 4500,
      currency: "EUR",
      basis: "stated",
    });

    const outcome = await runSiteAudit({
      profileId: b.profile_id,
      fetcher: b.fetcher,
      pagespeedFetch: fakePageSpeed({ pages: { [`${b.origin}/`]: { mobile: slowPhone } } }).fetch,
      apiKey: null,
    });
    expect(outcome.status).toBe("read");
    if (outcome.status !== "read") return;
    const euro = outcome.audit.findings.find((f) => f.code === "lcp_slow")?.euro;
    // 80 × €45 = €3,600; 2.3 s over; 1–4% a second → €82.80–€331.20, rounded to whole euros.
    expect(euro).toMatchObject({
      computed: true,
      low_minor: 8300,
      high_minor: 33100,
      currency: "EUR",
    });

    // The report's findings come from the audit the snapshot's fact names.
    const snap = await ensureSnapshot(b.profile_id, "report");
    const view = await readSnapshot(snap.id);
    const measured = await siteFindingsForReport(view.facts.get(SITE_AUDIT_KEY), b.profile_id);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((f) => f.kind === "measured" && f.evidence[0] === SITE_AUDIT_KEY)).toBe(
      true,
    );
    expect(measured[0]?.detail).toMatch(/a month at stake/);
    // Another business's fact can't pull this audit in.
    const other = await bootstrapIntake();
    created.push(other);
    expect(await siteFindingsForReport(view.facts.get(SITE_AUDIT_KEY), other.profile_id)).toEqual(
      [],
    );
    expect(await siteFindingsForReport(undefined, b.profile_id)).toEqual([]);
  });

  it("a generated report carries the measured findings beside the model's, marked and cited", async () => {
    const b = await business(`audit-${crypto.randomUUID().slice(0, 8)}.example`);
    const outcome = await runSiteAudit({
      profileId: b.profile_id,
      fetcher: b.fetcher,
      pagespeedFetch: fakePageSpeed({ pages: { [`${b.origin}/`]: { mobile: slowPhone } } }).fetch,
      apiKey: null,
    });
    expect(outcome.status).toBe("read");
    const findingsLlm: DiagnosisLlm = async () => ({
      text: JSON.stringify({
        summary: "Your site is the shop. It is slow on phones. Start there.",
        findings: [
          {
            area: "marketing",
            title: "The website is the only shop window",
            detail: "Everything sells through the site.",
            evidence: ["presence.website_url"],
            severity: "low",
            confidence: 0.6,
          },
        ],
      }),
      calls: [],
    });
    const recommendationsLlm: RecommendationsLlm = async () => ({
      text: JSON.stringify({
        recommendations: [
          {
            addresses: [0],
            title: "Record how many visits the site gets",
            rationale: "Speed is only worth money against your own traffic.",
            effort: "low",
            reversibility_level: "easy",
            if_you_change_your_mind: "Nothing to undo.",
            scenario: {
              kind: "close_gap",
              offer_id: null,
              change_pct: null,
              volume_response_base_pct: null,
              volume_response_downside_pct: null,
              volume_response_upside_pct: null,
              gap_field_keys: ["presence.website_url"],
              gap_why: "A number the next decision rests on.",
            },
          },
        ],
      }),
      calls: [],
    });
    const { report } = await generateReport({
      accountId: b.account_id,
      profileId: b.profile_id,
      findingsLlm,
      recommendationsLlm,
    });
    const measured = report.findings.filter((f) => f.kind === "measured");
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((f) => f.evidence[0] === SITE_AUDIT_KEY)).toBe(true);
    expect(report.findings[0]?.kind).toBe("measured"); // a high site finding outranks the low one
    expect(report.findings.some((f) => f.kind === undefined)).toBe(true);
    expect(report.fact_map[SITE_AUDIT_KEY]?.source_kind).toBe("web_research");
  });
});
