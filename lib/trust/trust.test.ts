// Session E — P3-25/26/28. The readback thresholds pinned at their
// boundaries in both directions (the anomaly discipline); the honest
// non-verdicts (too_early, unmeasured) proven; the scorecard's counts
// and approval-rate arithmetic; and suppression: the third decline of
// a kind provably silences it in generation, with the reason stated.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  diagnosisReports,
  fieldRecords,
  intakeEvents,
  metricObservations,
  profileSnapshots,
  proposals,
  users,
} from "../../db/schema";
import { matchStored } from "../i18n/stored";
import { bootstrapIntake } from "../intake/service";
import type { ClassifyLlm } from "../proposals/generate";
import { generateProposals } from "../proposals/generate";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  approveProposal,
  createProposal,
  recordExecution,
  rejectProposal,
} from "../proposals/service";
import { READBACK, readbackForProposal } from "./readback";
import { buildTrustView } from "./scorecard";
import { SUPPRESSION_THRESHOLD, suppressedKinds } from "./suppression";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-09-22T12:00:00Z");
const EXEC_DAY = "2026-09-01";

const scenario = {
  assumptions: [
    { statement: "volume holds", value: null, source_field: null, sensitivity: "high" },
  ],
  base_case: {
    case: "base",
    statement: "Revenue rises about 8%.",
    profit_delta_monthly: null,
    formula: null,
  },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-e-${crypto.randomUUID()}@test.local`,
      display_name: "Session E owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

function shift(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** Seed a connection with flat daily revenue before/after EXEC_DAY. */
async function seedRevenue(
  accountId: string,
  beforeMinor: number,
  afterMinor: number,
  afterDays = 14,
) {
  const [conn] = await db
    .insert(connections)
    .values({ account_id: accountId, provider: "stripe" })
    .returning({ id: connections.id });
  const rows = [];
  for (let i = READBACK.before_days; i >= 1; i--) {
    rows.push({ period_date: shift(EXEC_DAY, -i), value_minor: beforeMinor });
  }
  for (let i = 1; i <= afterDays; i++) {
    rows.push({ period_date: shift(EXEC_DAY, i), value_minor: afterMinor });
  }
  await db.insert(metricObservations).values(
    rows.map((r) => ({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "revenue.daily",
      dimensions: { currency: "EUR" },
      dimension_key: '{"currency":"EUR"}',
      period_date: r.period_date,
      value_minor: r.value_minor,
      currency: "EUR",
      observed_at: new Date().toISOString(),
    })),
  );
  return conn!.id;
}

async function executedProposal(
  s: { profile_id: string; user_id: string },
  kind = "price_increase",
) {
  const row = await createProposal({
    profile_id: s.profile_id,
    module: "diagnosis",
    action: { kind, summary: `${kind} fixture` },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: row.id, userId: s.user_id });
  // Pin the decision to EXEC_DAY so the windows are deterministic.
  await db
    .update(proposals)
    .set({ decided_at: `${EXEC_DAY}T09:00:00.000Z` })
    .where(eq(proposals.id, row.id));
  const executed = await recordExecution({ proposalId: row.id, result: { ok: true } });
  return executed;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(diagnosisReports).where(inArray(diagnosisReports.profile_id, ids));
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    if (conns.length > 0) {
      await db.delete(metricObservations).where(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
      );
      await db.delete(connections).where(eq(connections.account_id, s.account_id));
    }
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-25 — readback thresholds, at the boundary, both directions", () => {
  it("+5.0% exactly is helped; the arithmetic names both windows", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 10_500);
    const outcome = await readbackForProposal(await executedProposal(s), NOW);
    expect(outcome.verdict).toBe("helped");
    expect(outcome.delta_pct).toBe(5);
    expect(outcome.arithmetic).toContain("105.00 EUR");
    expect(outcome.arithmetic).toContain("100.00 EUR");
    // History reads this sentence back through the catalogue (lib/i18n/stored.ts):
    // the writer and ledgerWords.arith.revenue say the same words, or it prints raw.
    expect(matchStored(outcome.arithmetic, "ledgerWords.arith")?.key).toBe("revenue");
    expect(outcome.predicted).toBe("Revenue rises about 8%.");
  });

  it("+4.9% is did_nothing — the threshold is a line, not a vibe", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 10_490);
    const outcome = await readbackForProposal(await executedProposal(s), NOW);
    expect(outcome.verdict).toBe("did_nothing");
  });

  it("−5.0% exactly is backfired, said plainly", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 9_500);
    const outcome = await readbackForProposal(await executedProposal(s), NOW);
    expect(outcome.verdict).toBe("backfired");
    expect(outcome.delta_pct).toBe(-5);
  });

  it("−4.9% is did_nothing — the same line from the other side", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 9_510);
    const outcome = await readbackForProposal(await executedProposal(s), NOW);
    expect(outcome.verdict).toBe("did_nothing");
  });

  it("six measured days after is too_early; the seventh makes a verdict", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 11_000, READBACK.min_after_days - 1);
    const early = await readbackForProposal(await executedProposal(s), NOW);
    expect(early.verdict).toBe("too_early");
    expect(early.arithmetic).toContain("needs 7");
    expect(matchStored(early.arithmetic, "ledgerWords.arith")?.key).toBe("tooEarly");

    const s2 = await fresh();
    await seedRevenue(s2.account_id, 10_000, 11_000, READBACK.min_after_days);
    const judged = await readbackForProposal(await executedProposal(s2), NOW);
    expect(judged.verdict).toBe("helped");
  });

  it("no connected series: unmeasured, honestly", async () => {
    const s = await fresh();
    const outcome = await readbackForProposal(await executedProposal(s), NOW);
    expect(outcome.verdict).toBe("unmeasured");
    expect(outcome.arithmetic).toContain("connect a source");
    expect(matchStored(outcome.arithmetic, "ledgerWords.arith")?.key).toBe("noSeries");
  });
});

describe("P3-26 — the scorecard", () => {
  it("counts every state, computes the approval rate with its arithmetic, and scores outcomes", async () => {
    const s = await fresh();
    await seedRevenue(s.account_id, 10_000, 11_000);
    await executedProposal(s); // → helped

    const rejected = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "cold_outreach", summary: "no thanks" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await rejectProposal({ proposalId: rejected.id, userId: s.user_id, reason: "not our style" });

    await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "discount_or_promotion", summary: "held back" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      blocked_by_limit: "13.5: never discount",
    });

    const view = await buildTrustView(s.profile_id, NOW);
    expect(view.scorecard.made).toBe(3);
    expect(view.scorecard.executed).toBe(1);
    expect(view.scorecard.rejected).toBe(1);
    expect(view.scorecard.blocked).toBe(1);
    expect(view.scorecard.outcomes.helped).toBe(1);
    expect(view.scorecard.approval_rate).toEqual({ numerator: 1, denominator: 2, value: 50 });
    expect(view.scorecard.arithmetic).toContain("1 approved of 2 concluded");
    expect(view.scorecard.arithmetic).toContain("withheld by your limits, not counted");

    const executedEntry = view.history.find((h) => h.proposal.status === "executed");
    expect(executedEntry?.outcome?.verdict).toBe("helped");
    const rejectedEntry = view.history.find((h) => h.proposal.status === "rejected");
    expect(rejectedEntry?.outcome).toBeNull();
  });
});

describe("P3-28 — the third decline silences the kind", () => {
  it("two declines still propose; the third suppresses, with the reason stated", async () => {
    const s = await fresh();
    const decline = async () => {
      const row = await createProposal({
        profile_id: s.profile_id,
        module: "diagnosis",
        action: { kind: "price_increase", summary: "raise it" },
        scenario,
        reversibility: { level: "easy", if_you_change_your_mind: "undo" },
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await rejectProposal({ proposalId: row.id, userId: s.user_id, reason: "prices stay put" });
    };
    await decline();
    await decline();
    expect((await suppressedKinds(s.profile_id)).size).toBe(0);
    await decline();
    const suppressed = await suppressedKinds(s.profile_id);
    expect(suppressed.get("price_increase")?.rejections).toBe(SUPPRESSION_THRESHOLD);
    expect(suppressed.get("price_increase")?.reasons).toContain("prices stay put");

    // And generation now skips the kind instead of proposing it.
    const [snap] = await db
      .insert(profileSnapshots)
      .values({
        profile_id: s.profile_id,
        content_hash: "fx",
        fact_count: 0,
        entity_count: 0,
        entities: [],
      })
      .returning({ id: profileSnapshots.id });
    await db.insert(diagnosisReports).values({
      profile_id: s.profile_id,
      snapshot_id: snap!.id,
      summary: "fixture",
      completeness: "0.8",
      cost_eur: "0",
      unit_economics: {},
      findings: [],
      recommendations: [
        {
          addresses: [0],
          title: "Raise the flagship price",
          rationale: "margin",
          scenario,
          effort: "low",
          reversibility: { level: "easy", if_you_change_your_mind: "undo" },
          sensitivity_callouts: [],
          status: "proposed",
          rejection_reason: null,
        },
      ],
      data_gaps: [],
    });
    const classify: ClassifyLlm = async () => ({ text: '{"kind": "price_increase"}' });
    const limitLlm: LimitLlm = async () => ({ text: '{"limits": []}', calls: [] });
    const out = await generateProposals(s.profile_id, { classify, limitLlm });
    expect(out.created).toHaveLength(0);
    expect(out.skipped.some((x) => x.reason.includes("declined price increase 3 times"))).toBe(
      true,
    );
  });
});
