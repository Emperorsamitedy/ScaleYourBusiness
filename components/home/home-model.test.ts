import { describe, expect, it } from "vitest";
import type { CashLike, PendingLike, Read } from "./home-model";
import {
  cashReading,
  dataOf,
  periodFor,
  periodOptions,
  rankPending,
  readOutcome,
  signedOut,
  waitingCount,
  waitingLine,
} from "./home-model";

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
    // Today (900.00) is lower than every week ahead: the tile says the
    // lowest week is above today, so the larger figure does not read as a mistake.
    expect(r?.lowest).toEqual({
      start: "2026-11-16",
      low: 766800,
      under: true,
      aboveToday: true,
    });
    expect(r?.tight).toEqual({ start: "2026-11-09", low: 766800 });
  });

  it("a week ahead that dips under today is simply the lowest point", () => {
    expect(cashReading(ready(2000000, 950000, 1200000, false))?.lowest.aboveToday).toBe(false);
    // Level with today is not above it.
    expect(cashReading(ready(1200000, 950000, 1200000, false))?.lowest.aboveToday).toBe(false);
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

describe("Home: a read is an answer only once it has answered", () => {
  const reading = { state: "reading" } as const;
  const failed = { state: "failed" } as const;
  const out = { state: "signed_out" } as const;
  const nav = (pending: number): Read<{ pending: number }> => ({
    state: "read",
    data: { pending },
  });
  const queue = (n: number): Read<{ pending: readonly unknown[] }> => ({
    state: "read",
    data: { pending: Array.from({ length: n }, (_, i) => i) },
  });

  it("tells a refused read from a failed one, by status alone", () => {
    expect(readOutcome(200)).toBe("read");
    expect(readOutcome(401)).toBe("signed_out");
    expect(readOutcome(403)).toBe("failed");
    expect(readOutcome(500)).toBe("failed");
  });

  it("sends the visitor to sign in when any read was refused, and only then", () => {
    expect(signedOut([nav(2), out, failed])).toBe(true);
    expect(signedOut([nav(2), failed, reading])).toBe(false);
  });

  it("counts from the rail first, the queue second, and never from a read still out", () => {
    expect(waitingCount(nav(3), queue(1))).toEqual({ state: "known", count: 3 });
    expect(waitingCount(failed, queue(2))).toEqual({ state: "known", count: 2 });
    expect(waitingCount(reading, failed)).toEqual({ state: "reading" });
    expect(dataOf(reading)).toBeNull();
  });

  it('says it could not read, not "Reading…" for ever, when neither read answers', () => {
    expect(waitingCount(failed, failed)).toEqual({ state: "unread" });
    expect(waitingCount(out, out)).toEqual({ state: "unread" });
  });

  it('says "nothing to decide" only under a counted zero', () => {
    expect(waitingLine(0, false)).toBe("none");
    expect(waitingLine(3, true)).toBe("biggest");
    // Three decisions with no money range are not nothing: no line at all.
    expect(waitingLine(3, false)).toBeNull();
    // An unknown count, still reading or unread, claims nothing either.
    expect(waitingLine(null, false)).toBeNull();
  });
});

// docs/DASHBOARD-OVERHAUL.md C12: "Your sales" has a period switch.
describe("Home: the sales period switch", () => {
  it("offers each standard window the measured days fill, then all of them when they end between two", () => {
    expect(periodOptions(90)).toEqual([7, 30, 90]);
    expect(periodOptions(45)).toEqual([7, 30, 45]);
    expect(periodOptions(30)).toEqual([7, 30]);
    expect(periodOptions(22)).toEqual([7, 22]);
    expect(periodOptions(7)).toEqual([7]);
    expect(periodOptions(5)).toEqual([5]);
  });

  it("offers nothing without measured days, and never more than the widest window", () => {
    expect(periodOptions(0)).toEqual([]);
    expect(periodOptions(-3)).toEqual([]);
    expect(periodOptions(2.5)).toEqual([]);
    expect(periodOptions(400)).toEqual([7, 30, 90]);
  });

  it("shows the owner's last choice when it is offered, else thirty days, else the widest", () => {
    expect(periodFor(7, [7, 30, 90])).toBe(7);
    expect(periodFor(90, [7, 30])).toBe(30); // the days no longer reach ninety
    expect(periodFor(null, [7, 30, 90])).toBe(30);
    expect(periodFor(null, [7, 22])).toBe(22);
    expect(periodFor(30, [])).toBeNull();
  });
});
