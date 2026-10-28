// P5-15 — pipeline maths, pure. Each rule with a passing and a failing case:
// the stale test both ways, the measured/stated/none boundary at exactly the
// minimum, the stated band clamped, Wilson's range around the point, the
// weighted range per currency never mixed, and the refusal saying what it
// can and can't say (rule 25).

import { describe, expect, it } from "vitest";
import { money } from "../core/money";
import type { DealFacts } from "./maths";
import {
  PIPELINE,
  closedInWindow,
  dealAge,
  daysSince,
  stageAgeing,
  staleDeals,
  staleness,
  weightedValue,
  wilson,
  winRate,
} from "./maths";

const TODAY = "2026-10-27";

let n = 0;
function deal(over: Partial<DealFacts> = {}): DealFacts {
  n++;
  return {
    id: `d${String(n).padStart(3, "0")}`,
    stage: "qualified",
    stage_entered_at: "2026-10-01T09:00:00.000Z",
    created_at: "2026-09-20T09:00:00.000Z",
    closed_at: null,
    last_contact_at: null,
    value: money(400_000, "EUR"),
    value_basis: "quoted",
    next_step: "Send the sample box",
    next_step_due: "2026-11-02",
    ...over,
  };
}

function closed(stage: "won" | "lost", day: string): DealFacts {
  return deal({ stage, closed_at: `${day}T12:00:00.000Z`, next_step: null, next_step_due: null });
}

describe("P5-15 — stage ageing", () => {
  it("counts whole days in the stage and since the last word, saying which it counted from", () => {
    expect(daysSince("2026-10-01T23:59:00Z", TODAY)).toBe(26);
    expect(daysSince("2026-10-28T00:00:00Z", TODAY)).toBe(0); // never negative
    const spoken = dealAge(deal({ last_contact_at: "2026-10-04T15:00:00Z" }), TODAY);
    expect(spoken).toEqual({ days_in_stage: 26, days_quiet: 23, quiet_from: "last_contact" });
    // Not stated: counted from when the deal was added, and said so.
    const unstated = dealAge(deal(), TODAY);
    expect(unstated).toEqual({ days_in_stage: 26, days_quiet: 37, quiet_from: "added" });
  });

  it("gives each open stage its count, oldest and median; an empty stage has none", () => {
    const ageing = stageAgeing(
      [
        deal({ stage: "lead", stage_entered_at: "2026-10-20T00:00:00Z" }),
        deal({ stage: "lead", stage_entered_at: "2026-10-10T00:00:00Z" }),
        deal({ stage: "proposal_sent", stage_entered_at: "2026-09-27T00:00:00Z" }),
        closed("won", "2026-10-01"),
      ],
      TODAY,
    );
    expect(ageing).toEqual([
      { stage: "lead", deals: 2, oldest_days: 17, median_days: 12 },
      { stage: "qualified", deals: 0, oldest_days: null, median_days: null },
      { stage: "proposal_sent", deals: 1, oldest_days: 30, median_days: 30 },
    ]);
  });
});

describe("P5-15 — stale deals", () => {
  it("is stale with no next step, or with a next step past its date", () => {
    expect(staleness(deal({ next_step: null, next_step_due: null }), TODAY)).toEqual({
      why: "no_next_step",
    });
    expect(staleness(deal({ next_step: "   ", next_step_due: null }), TODAY)).toEqual({
      why: "no_next_step",
    });
    expect(staleness(deal({ next_step_due: "2026-10-20" }), TODAY)).toEqual({
      why: "overdue",
      due: "2026-10-20",
      days_over: 7,
    });
  });

  it("is not stale with a next step due today or later, a next step with no date, or once closed", () => {
    expect(staleness(deal({ next_step_due: TODAY }), TODAY)).toBeNull();
    expect(staleness(deal({ next_step_due: "2026-11-30" }), TODAY)).toBeNull();
    expect(staleness(deal({ next_step_due: null }), TODAY)).toBeNull();
    expect(staleness(closed("lost", "2026-10-01"), TODAY)).toBeNull();
  });

  it("lists the stale ones, longest quiet first", () => {
    const a = deal({ next_step: null, next_step_due: null, last_contact_at: "2026-10-20T00:00Z" });
    const b = deal({ next_step_due: "2026-10-01", last_contact_at: "2026-09-25T00:00Z" });
    const fresh = deal();
    const list = staleDeals([a, fresh, b], TODAY);
    expect(list.map((x) => x.deal.id)).toEqual([b.id, a.id]);
  });
});

describe("P5-15 — the business's own win rate", () => {
  const fiveClosed = [
    closed("won", "2026-09-01"),
    closed("won", "2026-08-01"),
    closed("lost", "2026-07-01"),
    closed("lost", "2026-06-01"),
    closed("lost", "2026-05-01"),
  ];

  it("is measured at exactly the minimum of closed deals, with the stated figure kept beside it", () => {
    const rate = winRate({ deals: fiveClosed, stated: 60, today: TODAY });
    expect(rate.basis).toBe("measured");
    if (rate.basis !== "measured") return;
    expect(rate.point).toBeCloseTo(0.4);
    expect(rate.low).toBeLessThan(0.4);
    expect(rate.high).toBeGreaterThan(0.4);
    expect(rate.stated).toBe(60); // shown, not swapped in
    expect(rate.closed).toMatchObject({ won: 2, lost: 3 });
    expect(rate.assumed[0]).toMatch(/your last 5/);
  });

  it("one short of the minimum, it falls back to the owner's stated rate, ±10 points, and says it's an estimate", () => {
    const rate = winRate({ deals: fiveClosed.slice(1), stated: 25, today: TODAY });
    expect(rate.basis).toBe("stated");
    if (rate.basis !== "stated") return;
    expect([rate.low, rate.point, rate.high]).toEqual([0.15, 0.25, 0.35]);
    expect(rate.needed).toBe(1);
    expect(rate.assumed[0]).toMatch(/your estimate, not a measurement/);
    // The band is clamped at both ends.
    const low = winRate({ deals: [], stated: 5, today: TODAY });
    const high = winRate({ deals: [], stated: 95, today: TODAY });
    expect(low.basis === "stated" && low.low).toBe(0);
    expect(high.basis === "stated" && high.high).toBe(1);
  });

  it("with neither, it refuses and says how many it has and what would make it ready", () => {
    const rate = winRate({ deals: fiveClosed.slice(2), stated: null, today: TODAY });
    expect(rate.basis).toBe("none");
    if (rate.basis !== "none") return;
    expect(rate.needed).toBe(2);
    expect(rate.reason).toMatch(/3 deals closed/);
    expect(rate.reason).toMatch(/6\.1f/);
    // A stated figure outside 0–100 is no figure at all.
    expect(winRate({ deals: [], stated: 140, today: TODAY }).basis).toBe("none");
  });

  it("counts only deals closed inside the window; open ones never count", () => {
    const window = closedInWindow(
      [
        closed("won", "2025-10-27"), // exactly 365 days back: in
        closed("won", "2025-10-26"), // a day before: out
        deal(),
      ],
      TODAY,
    );
    expect(window).toEqual({ won: 1, lost: 0, from: "2025-10-27", to: TODAY });
    expect(PIPELINE.window_days).toBe(365);
  });

  it("Wilson's range sits around the point and narrows with more deals", () => {
    const few = wilson(2, 5);
    const many = wilson(40, 100);
    expect(few.low).toBeLessThan(0.4);
    expect(few.high).toBeGreaterThan(0.4);
    expect(many.high - many.low).toBeLessThan(few.high - few.low);
    expect(wilson(0, 5).low).toBe(0);
    expect(wilson(5, 5).high).toBe(1);
  });
});

describe("P5-15 — weighted value as a range", () => {
  it("weighs open values per currency, never mixing them, in integer minor units", () => {
    const deals = [
      deal({ value: money(400_000, "EUR") }),
      deal({ value: money(250_050, "EUR"), value_basis: "estimated" }),
      deal({ value: money(120_000, "GBP") }),
      deal({ value: null, value_basis: null }),
      closed("won", "2026-10-01"), // closed: not open value
    ];
    const rate = winRate({ deals: [], stated: 30, today: TODAY });
    const w = weightedValue(deals, rate);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.lines.map((l) => l.currency)).toEqual(["EUR", "GBP"]);
    const eur = w.lines[0]!;
    expect(eur.open_total).toEqual(money(650_050, "EUR"));
    expect(eur.low).toEqual(money(130_010, "EUR")); // 650 050 × 0.20
    expect(eur.high).toEqual(money(260_020, "EUR")); // 650 050 × 0.40
    for (const m of [eur.low, eur.high]) expect(Number.isSafeInteger(m.amount_minor)).toBe(true);
    expect(w.unvalued).toBe(1);
    expect(w.estimated).toBe(1);
    expect(w.basis).toBe("stated");
    expect(w.sources.join(" ")).toMatch(/6\.1f/);
    expect(w.assumed.join(" ")).toMatch(/whatever its stage/);
    expect(w.assumed.join(" ")).toMatch(/1 value is your estimate/);
  });

  it("refuses without a win rate, saying what it can and can't say, and never borrowing one", () => {
    const w = weightedValue([deal(), deal({ value: null, value_basis: null })], {
      basis: "none",
      closed: { won: 0, lost: 0, from: "2025-10-27", to: TODAY },
      needed: 5,
      reason: "no rate",
    });
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.cant.join(" ")).toMatch(/borrow a win rate/);
    expect(w.ready_when).toMatch(/after 5 more closed deals/);
    expect(w.open_totals).toEqual([money(400_000, "EUR")]); // a sum, not a forecast
    expect(w.unvalued).toBe(1);
  });
});
