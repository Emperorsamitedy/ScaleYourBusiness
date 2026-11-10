// The Proof Ledger — architecture-v2 hard rule 2 and invariant I2, D10–D12.
// Against the real database: the append-only promise is a trigger, so only
// Postgres can prove it. Every row here outlives the test — that is the
// point of an append-only ledger (decision_log's tests live the same way),
// so each test works under fresh random ids and nothing collides.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { proofLedger } from "../../db/schema";
import { confidence } from "../core/confidence";
import { money } from "../core/money";
import {
  LedgerError,
  closeDueMeasurements,
  closeMeasurement,
  correctMeasurement,
  isOpen,
  openMeasurement,
  recordCounterfactual,
  requireOpen,
  verifiedEuro,
} from "./ledger";

const business = () => ({ profileId: randomUUID(), accountId: randomUUID() });
const A = confidence(0.95);
const B = confidence(0.75);
const C = confidence(0.55);

/** The Postgres error drizzle wraps — the trigger's words are on its cause. */
async function refusal(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return (error as { cause?: { message?: string } }).cause?.message ?? String(error);
  }
  return "no error";
}

async function plan(b = business(), extra: { proposalId?: string; windowDays?: number } = {}) {
  const opened = await openMeasurement({
    ...b,
    capability: "fixture",
    metric: "revenue",
    holdout: "the four weeks before, same weekdays",
    ...extra,
  });
  return { ...b, ...opened };
}

describe("hard rule 2 / I2 — the ledger is append-only, by trigger", () => {
  it("refuses an UPDATE, whoever asks — the trigger binds the table owner too", async () => {
    const p = await plan();
    expect(
      await refusal(
        db.execute(sql`update proof_ledger set note = 'edited' where id = ${p.measurement_id}`),
      ),
    ).toMatch(/append-only: UPDATE is not permitted/);
  });

  it("refuses a DELETE", async () => {
    const p = await plan();
    expect(
      await refusal(db.execute(sql`delete from proof_ledger where id = ${p.measurement_id}`)),
    ).toMatch(/append-only: DELETE is not permitted/);
    expect(await isOpen(p.measurement_id)).toBe(true);
  });

  it("refuses a TRUNCATE, which row triggers alone would miss", async () => {
    await plan();
    expect(await refusal(db.execute(sql`truncate proof_ledger`))).toMatch(
      /append-only: TRUNCATE is not permitted/,
    );
  });

  it("a correction is a NEW entry naming the original; the original stays as it was", async () => {
    const p = await plan();
    const closed = await closeMeasurement(p.measurement_id, {
      euro: money(10_000, "EUR"),
      inputs: [A, A],
      against: "holdout",
    });
    const fixed = await correctMeasurement(closed.id, {
      result: { euro: money(4_000, "EUR"), inputs: [A, A], against: "holdout" },
      reason: "the refund window had not closed when it was first scored",
    });
    expect(fixed.corrects_id).toBe(closed.id);
    expect(fixed.id).not.toBe(closed.id);
    const [original] = await db.select().from(proofLedger).where(eq(proofLedger.id, closed.id));
    expect(Number(original!.euro_minor)).toBe(10_000);
    // The counter reads the correction, not the original.
    expect(await verifiedEuro(p.profileId)).toEqual([money(4_000, "EUR")]);
  });
});

describe("open_measurement — before execution, one plan per action", () => {
  it("opens a plan with its window, and it reads as open until closed", async () => {
    const now = new Date("2026-11-10T09:00:00.000Z");
    const opened = await openMeasurement({
      ...business(),
      capability: "fixture",
      metric: "revenue",
      holdout: null,
      now,
    });
    expect(await isOpen(opened.measurement_id)).toBe(true);
    // D12: 28 days unless the capability's measurer says otherwise.
    expect(opened.window_ends_at).toBe("2026-12-08T09:00:00.000Z");
    await expect(requireOpen(opened.measurement_id)).resolves.toBeUndefined();
  });

  it("is idempotent per proposal: a retried execution reads the same plan", async () => {
    const b = business();
    const proposalId = randomUUID();
    const first = await plan(b, { proposalId });
    const again = await plan(b, { proposalId });
    expect(again.measurement_id).toBe(first.measurement_id);
    expect(again.reused).toBe(true);
  });

  it("execution without a plan is a hard error — an unknown id is never open", async () => {
    await expect(requireOpen(randomUUID())).rejects.toBeInstanceOf(LedgerError);
  });

  it("a closed plan is not open, and can't be closed twice", async () => {
    const p = await plan();
    await closeMeasurement(p.measurement_id, { unscored: "test" });
    expect(await isOpen(p.measurement_id)).toBe(false);
    await expect(requireOpen(p.measurement_id)).rejects.toBeInstanceOf(LedgerError);
    await expect(closeMeasurement(p.measurement_id, { unscored: "again" })).rejects.toBeInstanceOf(
      LedgerError,
    );
  });

  it("SHADOW's counterfactual is recorded once against the plan", async () => {
    const p = await plan();
    await recordCounterfactual(p.measurement_id, "would have paused the campaign");
    await recordCounterfactual(p.measurement_id, "would have paused the campaign");
    const rows = await db
      .select()
      .from(proofLedger)
      .where(eq(proofLedger.measurement_id, p.measurement_id));
    expect(rows.filter((r) => r.kind === "counterfactual")).toHaveLength(1);
  });
});

describe("close_measurement — the euro score and the verified counter (D10, hard rule 3)", () => {
  it("grades the score by its weakest input, never better", async () => {
    const p = await plan();
    const closed = await closeMeasurement(p.measurement_id, {
      euro: money(2_500, "EUR"),
      inputs: [A, B, C],
      against: "holdout",
    });
    expect(closed.grade).toBe("C");
    expect(closed.verified).toBe(false); // C isn't A or B
  });

  it("verifies only a holdout-scored A or B result, and totals per currency, never converted", async () => {
    const b = business();
    const counted = await plan(b);
    await closeMeasurement(counted.measurement_id, {
      euro: money(7_000, "EUR"),
      inputs: [A, B],
      against: "holdout",
    });
    const huf = await plan(b);
    await closeMeasurement(huf.measurement_id, {
      euro: money(500_000, "HUF"),
      inputs: [A],
      against: "holdout",
    });
    const beforeAfter = await plan(b);
    await closeMeasurement(beforeAfter.measurement_id, {
      euro: money(99_000, "EUR"),
      inputs: [A],
      against: "before_after",
    });
    const unscored = await plan(b);
    await closeMeasurement(unscored.measurement_id, { unscored: "no measurer yet" });

    const totals = await verifiedEuro(b.profileId);
    expect(totals).toHaveLength(2);
    expect(totals).toContainEqual(money(7_000, "EUR"));
    expect(totals).toContainEqual(money(500_000, "HUF"));
  });
});

describe("closing at window end (D11)", () => {
  it("closes a due plan through its capability's measurer, and an unmeasured one as unscored", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const measured = await openMeasurement({
      ...business(),
      capability: "measured_cap",
      metric: "revenue",
      holdout: "matched weeks",
      now: t0,
    });
    const unmeasured = await openMeasurement({
      ...business(),
      capability: "unmeasured_cap",
      metric: "revenue",
      holdout: null,
      now: t0,
    });
    const notDue = await openMeasurement({
      ...business(),
      capability: "measured_cap",
      metric: "revenue",
      holdout: null,
      now: new Date("2026-02-15T00:00:00.000Z"),
    });

    const outcomes: string[] = [];
    await closeDueMeasurements({
      now: new Date("2026-02-01T00:00:00.000Z"),
      measurers: {
        measured_cap: async () => ({
          euro: money(1_200, "EUR"),
          inputs: [A, A],
          against: "holdout",
        }),
      },
      onClosed: async (entry) => {
        outcomes.push(entry.measurement_id);
      },
      only: [measured.measurement_id, unmeasured.measurement_id, notDue.measurement_id],
    });

    expect(await isOpen(measured.measurement_id)).toBe(false);
    expect(await isOpen(unmeasured.measurement_id)).toBe(false);
    expect(await isOpen(notDue.measurement_id)).toBe(true);
    const [unscoredRow] = await db
      .select()
      .from(proofLedger)
      .where(eq(proofLedger.measurement_id, unmeasured.measurement_id));
    const close = (
      await db
        .select()
        .from(proofLedger)
        .where(eq(proofLedger.measurement_id, unmeasured.measurement_id))
    ).find((r) => r.kind === "close");
    expect(unscoredRow).toBeDefined();
    expect(close?.euro_minor).toBeNull();
    expect(close?.note).toMatch(/no measurer for unmeasured_cap yet/);
    expect(outcomes.sort()).toEqual([measured.measurement_id, unmeasured.measurement_id].sort());
  });
});
