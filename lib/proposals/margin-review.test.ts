// I-44a against the database: a large margin gap joins the report as a
// `kind: "benchmark"` finding the recommendations read as input (the
// prompts' text untouched), and prompts one margin review proposal through
// the existing path — held before care, once a month, nothing to execute it.
//
// The business: a one-person restaurant in Ireland, €20,000 a month, a 40 %
// gross margin and €8,000 of rent — an operating margin of 0 % against
// Eurostat's 14.9 % for Irish restaurants and cafés of every size (the
// committed snapshot, 2024): 14.9 points under, so large. Its twin pays
// €5,000 of rent: 15 %, about the same, so no gap.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  costItems,
  decisionLog,
  diagnosisReports,
  fieldRecords,
  modeDecisions,
  profileSnapshots,
  proposals,
  snapshotRecords,
} from "../../db/schema";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { DiagnosisLlm } from "../diagnosis/findings";
import type { RecommendationsLlm } from "../diagnosis/recommendations";
import { writeField } from "../profile/field-store";
import { generateReport } from "../report/service";
import type { LimitLlm } from "./hard-limits";
import {
  MARGIN_REVIEW_KIND,
  MARGIN_REVIEW_MODULE,
  marginReviewRef,
  proposeMarginReview,
} from "./margin-review";

const NOW = new Date("2026-11-03T09:00:00Z");
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const made: { account_id: string; profile_id: string }[] = [];

let realFetchUsed = false;
beforeEach(() => {
  realFetchUsed = false;
  vi.stubGlobal("fetch", async () => {
    realFetchUsed = true;
    throw new Error("no real network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(realFetchUsed).toBe(false);
});

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
}, 120_000);

afterAll(async () => {
  const ids = made.map((m) => m.profile_id);
  if (ids.length === 0) return;
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
  }
  await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(costItems).where(inArray(costItems.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(
    inArray(
      accounts.id,
      made.map((m) => m.account_id),
    ),
  );
});

async function restaurant(rentEur: number): Promise<string> {
  const [account] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  const profileId = profile!.id;
  made.push({ account_id: account!.id, profile_id: profileId });
  const write = (key: string, value: unknown) =>
    writeField(
      profileId,
      createField<unknown>({
        id: fieldId(key),
        value,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: isoDateTime("2026-10-01T10:00:00Z"),
        recorded_at: isoDateTime("2026-10-01T10:00:00Z"),
      }),
    );
  await write("identity.business_type", { code: "restaurant" });
  await write("legal.country", "Ireland");
  await write("identity.team_size", 1);
  await write("revenue.monthly_revenue", { amount_minor: 2_000_000, currency: "EUR" });
  await write("costs.gross_margin", 40);
  const [item] = await db
    .insert(costItems)
    .values({ profile_id: profileId, bucket: "fixed" })
    .returning({ id: costItems.id });
  await write(`costs.${item!.id}.label`, "Rent");
  await write(`costs.${item!.id}.category`, { code: "rent" });
  await write(`costs.${item!.id}.amount`, { amount_minor: rentEur * 100, currency: "EUR" });
  await write(`costs.${item!.id}.cadence`, { code: "monthly" });
  return profileId;
}

async function inCare(profileId: string) {
  await db.insert(modeDecisions).values({
    profile_id: profileId,
    mode: "instant",
    watch_weeks: null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
}

describe("a large gap in the report (I-44a)", () => {
  it("joins the findings as a benchmark finding, read by the recommendations as input", async () => {
    const profileId = await restaurant(8_000);
    const accountId = made.at(-1)!.account_id;
    const findingsLlm: DiagnosisLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          summary: "One. Two. Three.",
          findings: [
            {
              area: "finance",
              title: "Rent is a large share of revenue",
              detail: "Rent is €8,000 of €20,000.",
              evidence: ["revenue.monthly_revenue"],
              severity: "medium",
              confidence: 0.7,
            },
          ],
        }),
        calls: [],
      });
    const seen: { system: string; user: string }[] = [];
    const recommendationsLlm: RecommendationsLlm = (args) => {
      seen.push({ system: args.system, user: args.user });
      return Promise.resolve({
        text: JSON.stringify({
          recommendations: [
            {
              addresses: [0],
              title: "Look at the rent",
              rationale: "It is the largest cost.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "Nothing changes.",
              scenario: {
                kind: "close_gap",
                offer_id: null,
                change_pct: null,
                volume_response_base_pct: null,
                volume_response_downside_pct: null,
                volume_response_upside_pct: null,
                gap_field_keys: ["costs.gross_margin"],
                gap_why: "the margin rests on it",
              },
            },
          ],
        }),
        calls: [],
      });
    };
    const { report } = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
    });
    const bench = report.findings.filter((f) => f.kind === "benchmark");
    expect(bench).toHaveLength(1);
    expect(bench[0]!.title).toMatch(/14\.9 points below Eurostat's figure for/);
    expect(bench[0]!.detail).toMatch(/Source: Eurostat, sbs_sc_ovw, updated/);
    expect(bench[0]!.evidence).toContain("revenue.monthly_revenue");
    // The model's own finding is kept beside it.
    expect(report.findings.some((f) => f.kind === undefined)).toBe(true);
    // Fed as structured input: the finding is in the recommendations' FINDINGS
    // list, and the system prompt (the cached prefix) says nothing of it.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.user).toContain(bench[0]!.title);
    expect(seen[0]!.system).not.toMatch(/Eurostat|benchmark/i);
  });

  it("adds nothing when the margin is about the same as the sector's", async () => {
    const profileId = await restaurant(5_000);
    const accountId = made.at(-1)!.account_id;
    const findingsLlm: DiagnosisLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          summary: "One. Two. Three.",
          findings: [
            {
              area: "finance",
              title: "A finding",
              detail: "Detail.",
              evidence: ["revenue.monthly_revenue"],
              severity: "low",
              confidence: 0.7,
            },
          ],
        }),
        calls: [],
      });
    const recommendationsLlm: RecommendationsLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          recommendations: [
            {
              addresses: [0],
              title: "Keep going",
              rationale: "Fine.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "Nothing changes.",
              scenario: {
                kind: "close_gap",
                offer_id: null,
                change_pct: null,
                volume_response_base_pct: null,
                volume_response_downside_pct: null,
                volume_response_upside_pct: null,
                gap_field_keys: ["costs.gross_margin"],
                gap_why: "the margin rests on it",
              },
            },
          ],
        }),
        calls: [],
      });
    const { report } = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
    });
    expect(report.findings.filter((f) => f.kind === "benchmark")).toEqual([]);
  });
});

describe("a margin review proposal (I-44a)", () => {
  it("is held before the business is in care (rule 15)", async () => {
    const profileId = await restaurant(8_000);
    const run = await proposeMarginReview(profileId, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("held");
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, profileId))).toEqual(
      [],
    );
  });

  it("drafts one, with its log entry, once a month, with nothing to execute it", async () => {
    const profileId = await restaurant(8_000);
    await inCare(profileId);
    const run = await proposeMarginReview(profileId, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("created");
    if (!("proposal" in run)) return;
    const p = run.proposal;
    expect(p.module).toBe(MARGIN_REVIEW_MODULE);
    expect(p.status).toBe("pending");
    expect(p.originating_finding).toBe(marginReviewRef(NOW));
    const action = p.action as {
      kind: string;
      detail: { draft_only: boolean; sending: string; gap: { points: number } };
    };
    expect(action.kind).toBe(MARGIN_REVIEW_KIND);
    expect(action.kind).toBe("operations_change");
    expect(action.detail.draft_only).toBe(true);
    expect(action.detail.sending).toMatch(/I change nothing/);
    expect(action.detail.gap.points).toBe(14.9);
    const log = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, p.id));
    expect(log.map((l) => l.kind)).toEqual(["proposal"]);

    const again = await proposeMarginReview(profileId, { now: NOW, limitLlm: noLimits });
    expect(again.status).toBe("already");
  });

  it("refuses when there is no large gap", async () => {
    const profileId = await restaurant(5_000);
    await inCare(profileId);
    const run = await proposeMarginReview(profileId, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("no_gap");
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, profileId))).toEqual(
      [],
    );
  });
});
