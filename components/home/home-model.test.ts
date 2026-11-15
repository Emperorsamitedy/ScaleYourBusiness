import { describe, expect, it } from "vitest";
import type { CashLike, PendingLike } from "./home-model";
import { cashReading, rankPending } from "./home-model";

const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });
const pending = (id: string, low: number | null, high: number | null): PendingLike => ({
  id,
  module: "diagnosis",
  action: { summary: id },
  scenario: {
    downside_case: { statement: "", profit_delta_monthly: low === null ? null : eur(low) },
    upside_case: { statement: "", profit_delta_monthly: high === null ? null : eur(high) },
  },
});

describe("Home: what to put first", () => {
  it("lists money ranges first, the largest upside first, then the rest in queue order", () => {
    const got = rankPending([
      pending("site", null, null),
      pending("price", 13388, 123760),
      pending("ad", 5000, 20000),
      pending("find", null, null),
    ]);
    expect(got.map((r) => r.proposal.id)).toEqual(["price", "ad", "site"]);
    expect(got[0]?.range?.high.amount_minor).toBe(123760);
    expect(got[2]?.range).toBeNull();
  });

  it("never lists more than it is asked for, and nothing from an empty queue", () => {
    expect(rankPending([pending("a", 1, 2), pending("b", 1, 3)], 1)).toHaveLength(1);
    expect(rankPending([])).toEqual([]);
  });

  it("never blends two currencies into one range (rule 1)", () => {
    const mixed: PendingLike = {
      ...pending("mixed", 100, 200),
      scenario: {
        downside_case: { statement: "", profit_delta_monthly: eur(100) },
        upside_case: {
          statement: "",
          profit_delta_monthly: { amount_minor: 200, currency: "HUF" },
        },
      },
    };
    expect(rankPending([mixed])[0]?.range).toBeNull();
  });
});

describe("Home: the cash figures", () => {
  const ready = (start: number, line: number, low: number, tight: boolean): CashLike => ({
    forecast: {
      status: "ready",
      currency: "EUR",
      start: {
        amount_minor: start,
        currency: "EUR",
        basis: "STATED",
        source: "you told me",
        on: "2026-11-12",
      },
      line: { amount_minor: line, kind: "buffer" },
      lowest: { index: 1, balance: { low, high: low + 100 } },
      weeks: [{ start: "2026-11-09" }, { start: "2026-11-16" }],
    },
    tight: tight
      ? { start: "2026-11-09", balance: { low, high: low + 100 }, line, line_kind: "buffer" }
      : null,
  });

  it("says cash today is under the buffer, and which week is lowest", () => {
    const r = cashReading(ready(90000, 950000, 766800, true));
    expect(r?.under).toBe(true);
    expect(r?.lowest).toEqual({ start: "2026-11-16", low: 766800, under: true });
    expect(r?.tight).toEqual({ start: "2026-11-09", low: 766800 });
  });

  it("says nothing is tight when the forecast stays above the line", () => {
    const r = cashReading(ready(2000000, 950000, 1200000, false));
    expect(r?.under).toBe(false);
    expect(r?.lowest.under).toBe(false);
    expect(r?.tight).toBeNull();
  });

  it("prints no cash figure when the forecast refused or wasn't read", () => {
    expect(cashReading({ forecast: { status: "refused" }, tight: null })).toBeNull();
    expect(cashReading(null)).toBeNull();
  });
});
