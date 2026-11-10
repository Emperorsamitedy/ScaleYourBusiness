// The figure provenance object — the v1 build spec §6.1, hard rule 3,
// §12.1 "every number traces" and "grades never launder" (P7-31).
//
// The store computes a figure's grade from its provenance; the database's
// trigger (migration 0101) re-checks it against the stored inputs, so a
// caller that writes a better grade by hand is refused too.

import "dotenv/config";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, figures, intakeEvents } from "../../db/schema";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { FigureError, recordFigure, traceFigure } from "./figure";

const created: { account_id: string; profile_id: string }[] = [];
let profileId = "";
let otherProfileId = "";

beforeAll(async () => {
  const a = await bootstrapIntake();
  const b = await bootstrapIntake();
  created.push(a, b);
  profileId = a.profile_id;
  otherProfileId = b.profile_id;
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  await db.delete(figures).where(inArray(figures.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

const at = "2026-10-31T23:59:59Z";

function causeOf(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
}

describe("recording a figure", () => {
  it("a Stripe reading is measured, B, with its source in plain words", async () => {
    const f = await recordFigure({
      profileId,
      key: "revenue.monthly",
      value: money(1_250_000, "EUR"),
      provenance: { source: "measured" },
      source_detail: "Stripe, 2026-10-01 to 2026-10-31",
      captured_at: at,
    });
    expect(f.confidence).toBe("B");
    expect(f.currency).toBe("EUR");
    expect(Number(f.value)).toBe(1_250_000);
    expect(f.source_detail).toBe("Stripe, 2026-10-01 to 2026-10-31");
  });

  it("is A only when a second measured source cross-checks it", async () => {
    const bank = await recordFigure({
      profileId,
      key: "money_in.monthly",
      value: money(1_249_000, "EUR"),
      provenance: { source: "measured" },
      source_detail: "bank statement, 2026-10-01 to 2026-10-31",
      captured_at: at,
    });
    const stripe = await recordFigure({
      profileId,
      key: "revenue.monthly",
      value: money(1_250_000, "EUR"),
      provenance: { source: "measured", cross_checked: true },
      cross_check_id: bank.id,
      source_detail: "Stripe, 2026-10-01 to 2026-10-31, agrees with the bank statement",
      captured_at: at,
    });
    expect(stripe.confidence).toBe("A");
  });

  it("refuses an A with nothing to cross-check it against", async () => {
    await expect(
      recordFigure({
        profileId,
        key: "revenue.monthly",
        value: money(1, "EUR"),
        provenance: { source: "measured", cross_checked: true },
        source_detail: "Stripe",
        captured_at: at,
      }),
    ).rejects.toThrow(FigureError);
  });

  it("an owner's number is D", async () => {
    const f = await recordFigure({
      profileId,
      key: "costs.fixed_monthly",
      value: money(400_000, "EUR"),
      provenance: { source: "stated" },
      source_detail: "you told us, 2026-11-10",
      captured_at: at,
    });
    expect(f.confidence).toBe("D");
  });

  it("refuses money that isn't whole minor units (rule 1)", async () => {
    await expect(
      recordFigure({
        profileId,
        key: "x",
        value: { amount_minor: 10.5, currency: "EUR" },
        provenance: { source: "stated" },
        source_detail: "x",
        captured_at: at,
      }),
    ).rejects.toThrow();
  });
});

describe("hard rule 3 — a derived figure takes its inputs' lowest grade", () => {
  it("passing case: arithmetic on two B figures is B", async () => {
    const revenue = await recordFigure({
      profileId,
      key: "revenue.monthly",
      value: money(1_000_000, "EUR"),
      provenance: { source: "measured" },
      source_detail: "Stripe",
      captured_at: at,
    });
    const orders = await recordFigure({
      profileId,
      key: "orders.monthly",
      value: 400,
      provenance: { source: "measured" },
      source_detail: "Stripe",
      captured_at: at,
    });
    const aov = await recordFigure({
      profileId,
      key: "average_order_value",
      value: money(2_500, "EUR"),
      derived: { from: [revenue.id, orders.id], method: "revenue ÷ orders" },
      source_detail: "computed",
      captured_at: at,
    });
    expect(aov.confidence).toBe("B");
    expect(aov.source).toBe("derived");
    expect(aov.depends_on).toEqual([revenue.id, orders.id]);
  });

  it("failing case: break-even on one stated fixed cost is D", async () => {
    const margin = await recordFigure({
      profileId,
      key: "margin.pct",
      value: 40,
      provenance: { source: "measured" },
      source_detail: "Shopify",
      captured_at: at,
    });
    const fixed = await recordFigure({
      profileId,
      key: "costs.fixed_monthly",
      value: money(400_000, "EUR"),
      provenance: { source: "stated" },
      source_detail: "you told us",
      captured_at: at,
    });
    const breakEven = await recordFigure({
      profileId,
      key: "break_even.monthly",
      value: money(1_000_000, "EUR"),
      derived: { from: [margin.id, fixed.id], method: "fixed ÷ margin" },
      source_detail: "computed",
      captured_at: at,
    });
    expect(breakEven.confidence).toBe("D");

    // …and stays D one step further on: a grade can't be laundered by
    // deriving from the derivation.
    const target = await recordFigure({
      profileId,
      key: "revenue.target",
      value: money(1_200_000, "EUR"),
      derived: { from: [breakEven.id], method: "break-even × 1.2" },
      source_detail: "computed",
      captured_at: at,
    });
    expect(target.confidence).toBe("D");
  });

  it("modelling caps a derived figure at C", async () => {
    const revenue = await recordFigure({
      profileId,
      key: "revenue.monthly",
      value: money(1_000_000, "EUR"),
      provenance: { source: "measured" },
      source_detail: "Stripe",
      captured_at: at,
    });
    const leak = await recordFigure({
      profileId,
      key: "leak.abandoned_carts",
      value: money(80_000, "EUR"),
      derived: {
        from: [revenue.id],
        method: "revenue × an assumed 8% recovery rate",
        modelled: true,
      },
      source_detail: "estimate",
      captured_at: at,
    });
    expect(leak.confidence).toBe("C");
  });

  it("a figure can't depend on another business's figure", async () => {
    const theirs = await recordFigure({
      profileId: otherProfileId,
      key: "revenue.monthly",
      value: money(1, "EUR"),
      provenance: { source: "measured" },
      source_detail: "Stripe",
      captured_at: at,
    });
    await expect(
      recordFigure({
        profileId,
        key: "x",
        value: 1,
        derived: { from: [theirs.id], method: "x" },
        source_detail: "x",
        captured_at: at,
      }),
    ).rejects.toThrow(FigureError);
  });
});

describe("the database is the backstop (migration 0101)", () => {
  it("refuses a hand-written derived figure graded better than its inputs", async () => {
    const stated = await recordFigure({
      profileId,
      key: "costs.fixed_monthly",
      value: money(1, "EUR"),
      provenance: { source: "stated" },
      source_detail: "you told us",
      captured_at: at,
    });
    const error = await db
      .insert(figures)
      .values({
        profile_id: profileId,
        key: "laundered",
        value: "1",
        source: "derived",
        source_detail: "x",
        captured_at: at,
        confidence: "B",
        depends_on: [stated.id],
        method: "x",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/grades never launder/);
  });

  it("refuses a stated figure graded anything but D", async () => {
    const error = await db
      .insert(figures)
      .values({
        profile_id: profileId,
        key: "x",
        value: "1",
        source: "stated",
        source_detail: "x",
        captured_at: at,
        confidence: "B",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/figures_stated_is_d/);
  });

  it("never lets a figure be edited", async () => {
    const f = await recordFigure({
      profileId,
      key: "costs.fixed_monthly",
      value: money(1, "EUR"),
      provenance: { source: "stated" },
      source_detail: "you told us",
      captured_at: at,
    });
    const error = await db
      .update(figures)
      .set({ confidence: "A" })
      .where(eq(figures.id, f.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/never edited/);
    const [still] = await db.select().from(figures).where(eq(figures.id, f.id));
    expect(still?.confidence).toBe("D");
  });

  it("lets erasure delete a business's figures with it", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await recordFigure({
      profileId: s.profile_id,
      key: "x",
      value: 1,
      provenance: { source: "stated" },
      source_detail: "x",
      captured_at: at,
    });
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(figures)
      .where(eq(figures.profile_id, s.profile_id));
    expect(left?.n).toBe(0);
  });
});

describe("§12.1 every number traces", () => {
  it("a figure reaches its provenance and each input's in one call", async () => {
    const revenue = await recordFigure({
      profileId,
      key: "revenue.monthly",
      value: money(900_000, "EUR"),
      provenance: { source: "measured" },
      source_detail: "Stripe, October",
      captured_at: at,
    });
    const fixed = await recordFigure({
      profileId,
      key: "costs.fixed_monthly",
      value: money(300_000, "EUR"),
      provenance: { source: "stated" },
      source_detail: "you told us",
      captured_at: at,
    });
    const profit = await recordFigure({
      profileId,
      key: "profit.monthly",
      value: money(600_000, "EUR"),
      derived: { from: [revenue.id, fixed.id], method: "revenue − fixed costs" },
      source_detail: "computed",
      captured_at: at,
    });
    const trace = await traceFigure(profileId, profit.id);
    expect(trace?.figure.id).toBe(profit.id);
    expect(trace?.inputs.map((i) => [i.figure.key, i.figure.confidence])).toEqual([
      ["revenue.monthly", "B"],
      ["costs.fixed_monthly", "D"],
    ]);
    // The weakest input is named, so the owner sees WHY it is D.
    expect(trace?.weakest?.id).toBe(fixed.id);
  });

  it("another business's figure doesn't trace", async () => {
    const theirs = await recordFigure({
      profileId: otherProfileId,
      key: "x",
      value: 1,
      provenance: { source: "stated" },
      source_detail: "x",
      captured_at: at,
    });
    expect(await traceFigure(profileId, theirs.id)).toBeNull();
  });
});
