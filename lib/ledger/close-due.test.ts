// Steps 5 → 6: a due plan is closed, and the ladder hears the outcome.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { ladderEvents } from "../../db/schema";
import { money } from "../core/money";
import { promotionEligibility } from "../ladder/ladder";
import { closeAndRecord } from "./close-due";
import type { OpenPlanInput } from "./plans";
import { isPlanOpen, openPlan } from "./plans";

const t0 = new Date("2026-03-01T00:00:00.000Z");

function plan(profileId: string, over: Partial<OpenPlanInput> = {}): OpenPlanInput {
  return {
    profileId,
    accountId: randomUUID(),
    provider: "fixture",
    action_summary: "Set a fixture value",
    hypothesis: "Nothing real changes",
    expected: { effect: money(3_000, "EUR"), low: money(0, "EUR"), high: money(6_000, "EUR") },
    currency: "EUR",
    reversible: true,
    opened_by: "agent",
    station: 3,
    shadow: false,
    now: t0,
    ...over,
  };
}

describe("closing at window end feeds the ladder (steps 5 and 6)", () => {
  it("records each close as an outcome the ladder counts", async () => {
    const profileId = randomUUID();
    const scored = (await openPlan(plan(profileId))).plan;
    const unscored = (await openPlan(plan(profileId, { windowDays: 7 }))).plan;

    const result = await closeAndRecord({
      now: new Date("2026-04-01T00:00:00.000Z"),
      only: [scored.id, unscored.id],
      measurers: {
        fixture: async (p) =>
          p.id === scored.id
            ? { observed_minor: 3_000, low_minor: 1_000, high_minor: 5_000, method_notes: "t" }
            : { inconclusive: "nothing to compare against" },
      },
    });

    expect(result).toEqual({ closed: 2, left_open: 0 });
    expect(await isPlanOpen(scored.id)).toBe(false);
    const events = await db
      .select()
      .from(ladderEvents)
      .where(and(eq(ladderEvents.profile_id, profileId), eq(ladderEvents.kind, "outcome")));
    expect(events.map((e) => e.measurement_id).sort()).toEqual([scored.id, unscored.id].sort());
    const outcomes = events.map((e) => e.outcome as { verdict: string; euro_minor: number | null });
    expect(outcomes.map((o) => o.verdict).sort()).toEqual(["inconclusive", "verified_gain"]);
    expect(await promotionEligibility(profileId, "fixture")).toMatchObject({
      eligible: false,
      outcomes: { total: 2, verified: 1 },
    });
  });

  it("a measurer that throws leaves its plan open for the next run, not closed with a guess", async () => {
    const p = (await openPlan(plan(randomUUID()))).plan;
    const result = await closeAndRecord({
      now: new Date("2026-04-01T00:00:00.000Z"),
      only: [p.id],
      measurers: {
        fixture: async () => {
          throw new Error("the connector was down");
        },
      },
    });
    expect(result).toEqual({ closed: 0, left_open: 1 });
    expect(await isPlanOpen(p.id)).toBe(true);
  });
});
