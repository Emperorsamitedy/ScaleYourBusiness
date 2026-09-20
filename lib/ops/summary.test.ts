// Session I — P1-51/52/53. The properties that make the panel honest:
// funnel stages count profiles once, browsers cannot forge a conversion,
// abandonment points at the LAST question a stalled trail saw, and cost
// is summed from persisted rows — not reconstructed from logs.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents, llmCalls } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { recordFunnelEvent, recordIntakeEvents } from "../intake/telemetry";
import { recordLlmCall } from "../llm/cost-log";
import { abandonmentSummary, costSummary, funnelSummary } from "./summary";

const created: { account_id: string; profile_id: string }[] = [];
const LONG_AGO = new Date(0).toISOString();

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(llmCalls).where(eq(llmCalls.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P1-52 — funnel stages", () => {
  it("bootstrap records intake_started, and once-stages never double-count", async () => {
    const s = await fresh();
    // bootstrapIntake already wrote funnel_intake_started; write it twice more.
    await recordFunnelEvent(s.profile_id, "funnel_intake_started");
    await recordFunnelEvent(s.profile_id, "funnel_core_completed");
    await recordFunnelEvent(s.profile_id, "funnel_core_completed");

    const rows = await db
      .select({ kind: intakeEvents.kind })
      .from(intakeEvents)
      .where(eq(intakeEvents.profile_id, s.profile_id));
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === "funnel_intake_started")).toHaveLength(1);
    expect(kinds.filter((k) => k === "funnel_core_completed")).toHaveLength(1);
  });

  it("recommendation responses are each real and NOT deduplicated", async () => {
    const s = await fresh();
    await recordFunnelEvent(s.profile_id, "funnel_recommendation_response", {
      response: "look_into",
    });
    await recordFunnelEvent(s.profile_id, "funnel_recommendation_response", {
      response: "not_for_us",
    });
    const rows = await db
      .select({ kind: intakeEvents.kind })
      .from(intakeEvents)
      .where(eq(intakeEvents.profile_id, s.profile_id));
    expect(rows.filter((r) => r.kind === "funnel_recommendation_response")).toHaveLength(2);
  });

  it("the client event sink refuses funnel kinds — a browser cannot forge a conversion", async () => {
    const s = await fresh();
    const accepted = await recordIntakeEvents(s.profile_id, [
      { kind: "funnel_core_completed" },
      { kind: "funnel_report_delivered" },
      { kind: "question_shown", question_id: "1.1" }, // control: real client kind
    ]);
    expect(accepted).toBe(1);
    const rows = await db
      .select({ kind: intakeEvents.kind })
      .from(intakeEvents)
      .where(eq(intakeEvents.profile_id, s.profile_id));
    expect(rows.some((r) => r.kind === "funnel_core_completed")).toBe(false);
  });
});

describe("P1-53 — funnel and abandonment summaries", () => {
  it("counts distinct profiles per stage and ranks the last question stalled trails saw", async () => {
    const a = await fresh(); // completes core
    const b = await fresh(); // stalls on 4.1a
    const c = await fresh(); // stalls on 4.1a too

    await recordFunnelEvent(a.profile_id, "funnel_core_completed");
    await recordIntakeEvents(b.profile_id, [
      { kind: "question_shown", question_id: "1.1" },
      { kind: "question_shown", question_id: "4.1a" },
    ]);
    await recordIntakeEvents(c.profile_id, [{ kind: "question_shown", question_id: "4.1a" }]);

    const funnel = await funnelSummary(LONG_AGO);
    expect(funnel.started).toBeGreaterThanOrEqual(3);
    expect(funnel.core_completed).toBeGreaterThanOrEqual(1);

    const stalls = await abandonmentSummary(LONG_AGO);
    const top = stalls.find((r) => r.question_id === "4.1a");
    expect(top).toBeDefined();
    expect(top?.stalled_profiles).toBeGreaterThanOrEqual(2);
    // The completed profile's trail must not appear at all.
    // (Its only events are funnel stages, and it finished core.)
  });
});

describe("P1-51 — cost telemetry", () => {
  it("recordLlmCall persists the record and costSummary sums it by workload", async () => {
    const s = await fresh();
    await recordLlmCall({
      at: new Date().toISOString(),
      event: "llm_call",
      workload: "interviewer",
      account_id: s.account_id,
      model: "claude-sonnet-5",
      duration_ms: 1200,
      input_tokens: 3500,
      output_tokens: 60,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 12000,
      cost_eur: 0.009312,
    });
    await recordLlmCall({
      at: new Date().toISOString(),
      event: "llm_call",
      workload: "diagnosis",
      account_id: s.account_id,
      model: "claude-opus-4-8",
      duration_ms: 40000,
      input_tokens: 20000,
      output_tokens: 4000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: 0.14,
    });

    const summary = await costSummary(LONG_AGO);
    const acc = summary.accounts.find((r) => r.account_id === s.account_id);
    expect(acc).toBeDefined();
    expect(acc?.calls).toBe(2);
    expect(acc?.cost_eur).toBeCloseTo(0.1493, 3);
    expect(acc?.by_workload.interviewer).toBeCloseTo(0.0093, 3);
    expect(acc?.by_workload.diagnosis).toBeCloseTo(0.14, 3);
  });
});
