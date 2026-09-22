// P3-04 — generation over a real profile with a fixture report and a
// seeded anomaly, all model seams faked and call-counted. What must
// hold: a rule-14 hit is born blocked with the owner's words; a clean
// recommendation lands pending; a declined recommendation is never
// re-proposed; an unclassifiable one is skipped, not guessed; re-runs
// are idempotent at zero model cost; interrupts propose deterministically.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  businessProfiles,
  connections,
  diagnosisReports,
  fieldRecords,
  intakeEvents,
  profileSnapshots,
  proposals,
} from "../../db/schema";
import { createField } from "../core/field";
import { confidence } from "../core/confidence";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { bootstrapIntake } from "../intake/service";
import type { StoredRecommendation } from "../report/service";
import type { ClassifyLlm } from "./generate";
import { coerceKind, generateProposals } from "./generate";
import type { LimitLlm } from "./hard-limits";
import { BOUNDARIES_KEY } from "./hard-limits";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
};

function rec(title: string, status: StoredRecommendation["status"] = "proposed") {
  return {
    addresses: [0],
    title,
    rationale: `${title} — because the numbers say so`,
    scenario,
    effort: "low",
    reversibility: { level: "easy", if_you_change_your_mind: "undo it" },
    sensitivity_callouts: [],
    status,
    rejection_reason: status === "rejected" ? "not for us" : null,
  } as unknown as StoredRecommendation;
}

async function seedReport(profileId: string, recs: StoredRecommendation[]) {
  const [snap] = await db
    .insert(profileSnapshots)
    .values({
      profile_id: profileId,
      content_hash: "fixture",
      fact_count: 0,
      entity_count: 0,
      entities: [],
    })
    .returning({ id: profileSnapshots.id });
  await db.insert(diagnosisReports).values({
    profile_id: profileId,
    snapshot_id: snap!.id,
    summary: "Fixture report.",
    completeness: "0.8",
    cost_eur: "0",
    unit_economics: {},
    findings: [],
    recommendations: recs,
    data_gaps: [],
  });
}

async function writeBoundaries(profileId: string, text: string) {
  await writeField(
    profileId,
    createField<string>({
      id: fieldId(BOUNDARIES_KEY),
      value: text,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: isoDateTime(new Date().toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
    }),
  );
}

const limitsLlm: LimitLlm = async () => ({
  text: JSON.stringify({ limits: [{ code: "no_discounts", quote: "we never discount" }] }),
  calls: [],
});

/** Classifier fake: answers from a queue, counts calls. */
function fakeClassify(kinds: string[]): { llm: ClassifyLlm; calls: () => number } {
  let n = 0;
  const llm: ClassifyLlm = async () => {
    // Off the end of the queue the fake stays junk — an exhausted fixture
    // must not accidentally classify something.
    const kind = kinds[n] ?? "world_domination";
    n += 1;
    return { text: JSON.stringify({ kind }) };
  };
  return { llm, calls: () => n };
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(anomalies).where(inArray(anomalies.profile_id, ids));
    await db.delete(diagnosisReports).where(inArray(diagnosisReports.profile_id, ids));
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
  }
  if (ids.length > 0) {
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-04 — coerceKind", () => {
  it("accepts only members of the closed set; everything else is null", () => {
    expect(coerceKind('{"kind": "price_increase"}')).toBe("price_increase");
    expect(coerceKind('{"kind": "world_domination"}')).toBeNull();
    expect(coerceKind("nonsense")).toBeNull();
  });
});

describe("P3-04 — generation", () => {
  it("blocks the rule-14 hit, creates the clean one, skips the declined and the unclassifiable", async () => {
    const s = await fresh();
    await writeBoundaries(s.profile_id, "We never discount.");
    await seedReport(s.profile_id, [
      rec("Run a January sale"), // classifier → discount_or_promotion → blocked
      rec("Raise the flagship price by 8%"), // classifier → price_increase → pending
      rec("Do a podcast tour", "rejected"), // declined on the report → skipped, no classify
      rec("Something weird"), // classifier returns junk → skipped, no guess
    ]);
    const { llm, calls } = fakeClassify([
      "discount_or_promotion",
      "price_increase",
      "world_domination",
    ]);

    const out = await generateProposals(s.profile_id, { classify: llm, limitLlm: limitsLlm });

    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0]?.blocked_by_limit).toBe("13.5: we never discount");
    expect(out.blocked[0]?.status).toBe("blocked");
    expect(out.created).toHaveLength(1);
    expect(out.created[0]?.status).toBe("pending");
    expect((out.created[0]?.action as { summary: string }).summary).toBe(
      "Raise the flagship price by 8%",
    );
    expect(out.skipped.map((x) => x.reason).sort()).toEqual([
      "owner declined this on the report",
      "unclassifiable — not proposing on a guess",
    ]);
    // Declined rec never reached the classifier: 3 calls for 4 recs.
    expect(calls()).toBe(3);

    // Idempotence: the re-run creates nothing and consults no model.
    const again = await generateProposals(s.profile_id, { classify: llm, limitLlm: limitsLlm });
    expect(again.created).toHaveLength(0);
    expect(again.blocked).toHaveLength(0);
    expect(calls()).toBe(4); // only the still-unproposed junk rec re-classifies
  });

  it("an open interrupt anomaly proposes an investigation deterministically", async () => {
    const s = await fresh();
    const [conn] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "stripe" })
      .returning({ id: connections.id });
    const seed = {
      profile_id: s.profile_id,
      connection_id: conn!.id,
      metric_key: "revenue.daily",
      dimension_key: "-",
      first_date: "2026-09-15",
      last_date: "2026-09-17",
      run_days: 3,
      actual: "5100.0000",
      expected: "8200.0000",
      deviation: "-3.400",
      detail: "Revenue 38% below the weekday baseline for 3 days.",
      inputs: {},
    };
    await db.insert(anomalies).values([
      { ...seed, direction: "drop" as const, severity: "interrupt" as const },
      {
        ...seed,
        metric_key: "orders.daily",
        direction: "drop" as const,
        severity: "notice" as const,
      },
    ]);

    const { llm, calls } = fakeClassify([]);
    const out = await generateProposals(s.profile_id, { classify: llm, limitLlm: limitsLlm });

    expect(out.created).toHaveLength(1); // the interrupt; the notice stays quiet
    const action = out.created[0]?.action as { kind: string; summary: string };
    expect(action.kind).toBe("operations_change");
    expect(action.summary).toContain("Investigate");
    expect(calls()).toBe(0); // deterministic template, no model
  });
});
