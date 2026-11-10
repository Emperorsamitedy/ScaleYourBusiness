// Steps 5 → 6: a due plan is closed, and the ladder hears the outcome.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { ladderEvents } from "../../db/schema";
import { confidence } from "../core/confidence";
import { money } from "../core/money";
import { promotionEligibility } from "../ladder/ladder";
import { closeAndRecord } from "./close-due";
import { isOpen, openMeasurement } from "./ledger";

describe("closing at window end feeds the ladder (steps 5 and 6)", () => {
  it("records each close as an outcome the ladder counts", async () => {
    const profileId = randomUUID();
    const t0 = new Date("2026-03-01T00:00:00.000Z");
    const scored = await openMeasurement({
      profileId,
      accountId: randomUUID(),
      capability: "fixture",
      metric: "revenue",
      holdout: "matched weeks",
      now: t0,
    });
    const unscored = await openMeasurement({
      profileId,
      accountId: randomUUID(),
      capability: "fixture",
      metric: "revenue",
      holdout: null,
      now: t0,
      windowDays: 7,
    });

    const result = await closeAndRecord({
      now: new Date("2026-04-01T00:00:00.000Z"),
      only: [scored.measurement_id, unscored.measurement_id],
      measurers: {
        fixture: async (plan) =>
          plan.id === scored.measurement_id
            ? { euro: money(3_000, "EUR"), inputs: [confidence(0.95)], against: "holdout" }
            : { unscored: "nothing to compare against" },
      },
    });

    expect(result).toEqual({ closed: 2, left_open: 0 });
    expect(await isOpen(scored.measurement_id)).toBe(false);
    const events = await db
      .select()
      .from(ladderEvents)
      .where(and(eq(ladderEvents.profile_id, profileId), eq(ladderEvents.kind, "outcome")));
    expect(events.map((e) => e.measurement_id).sort()).toEqual(
      [scored.measurement_id, unscored.measurement_id].sort(),
    );
    expect(await promotionEligibility(profileId, "fixture")).toMatchObject({
      eligible: false,
      outcomes: { total: 2, verified: 1 },
    });
  });

  it("a measurer that throws leaves its plan open for the next run, not closed with a guess", async () => {
    const plan = await openMeasurement({
      profileId: randomUUID(),
      accountId: randomUUID(),
      capability: "fixture",
      metric: "revenue",
      holdout: null,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    const result = await closeAndRecord({
      now: new Date("2026-04-01T00:00:00.000Z"),
      only: [plan.measurement_id],
      measurers: {
        fixture: async () => {
          throw new Error("the connector was down");
        },
      },
    });
    expect(result).toEqual({ closed: 0, left_open: 1 });
    expect(await isOpen(plan.measurement_id)).toBe(true);
  });
});
