// I-54a — the cash forecast's weekly closing balances on the track record.
// What must hold:
//   · cash today is a bank statement's balance when it is a week old or
//     less, with the owner's own figure kept beside it, and the owner's
//     figure when the statement is older or there is none;
//   · the next four weeks' closing balances are claims only when the
//     forecast started from a statement's balance, once per ISO week, with
//     the range shown;
//   · a claim is graded by the statement's closing balance on the week's
//     last day, and waits up to six weeks for a statement covering it.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { cashToday } from "../cash/load";
import { baseInputs, eur, TODAY } from "../cash/fixtures";
import type { MoneyFact } from "../cash/model";
import { forecastCash } from "../cash/model";
import { addDays } from "../seasons/forecast";
import { CASH_CLAIM_WEEKS, cashClaims } from "./claims";
import type { ClaimRow, DayValue } from "./grade";
import { GRADE, gradeCashClose } from "./grade";

const statement = (on: string, major = 4200): MoneyFact => ({
  amount_minor: major * 100,
  currency: "EUR",
  basis: "OBSERVED",
  source: "your bank statement's closing balance",
  on,
});

describe("cash today", () => {
  it("is the statement's balance when it's a week old or less, the owner's figure kept beside it", () => {
    const stated = { status: "known" as const, fact: eur(5000) };
    const fresh = cashToday(stated, statement(addDays(TODAY, -7)), TODAY);
    expect(fresh.cash).toEqual({ status: "known", fact: statement(addDays(TODAY, -7)) });
    expect(fresh.stated_cash).toEqual(eur(5000));
    const old = cashToday(stated, statement(addDays(TODAY, -8)), TODAY);
    expect(old).toEqual({ cash: stated, stated_cash: null });
    expect(cashToday({ status: "missing" }, null, TODAY)).toEqual({
      cash: { status: "missing" },
      stated_cash: null,
    });
    // With no figure of the owner's, the statement still counts.
    expect(cashToday({ status: "unknown" }, statement(TODAY), TODAY).cash.status).toBe("known");
  });

  it("the forecast says it started from the statement, and shows the owner's figure beside it", () => {
    const f = forecastCash(
      baseInputs({
        cash: { status: "known", fact: statement(addDays(TODAY, -2)) },
        stated_cash: eur(5000),
      }),
    );
    expect(f.status).toBe("ready");
    if (f.status !== "ready") return;
    expect(f.sources[0]).toMatchObject({ label: "Cash today", basis: "OBSERVED" });
    expect(f.sources[1]).toMatchObject({ label: "Cash you told me", basis: "STATED" });
    expect(f.assumptions.join(" ")).toMatch(/what came in or went out since then isn't counted/);
  });
});

const owner = { account_id: "a", profile_id: "p" };
const NOW = new Date(`${TODAY}T10:00:00Z`);

describe("the claims", () => {
  it("records the next four weeks' closing balances as shown, when cash today is a statement's", () => {
    const f = forecastCash(baseInputs({ cash: { status: "known", fact: statement(TODAY) } }));
    if (f.status !== "ready") throw new Error("fixture");
    const claims = cashClaims(owner, f, { connection_id: "conn" }, NOW);
    expect(claims).toHaveLength(CASH_CLAIM_WEEKS);
    const first = claims[0]!;
    const w = f.weeks[0]!;
    expect(first).toMatchObject({
      kind: "cash_close",
      unit: "money",
      metric: "cash.balance",
      currency: "EUR",
      window_start: w.start,
      window_end: w.end,
      low_minor: Math.floor(Math.min(w.balance.low, w.balance.high)),
      high_minor: Math.ceil(Math.max(w.balance.low, w.balance.high)),
    });
    expect(first.subject_ref).toMatchObject({ connection_id: "conn", week_index: 0 });
    expect(first.basis).toMatch(/Started from your bank statement's closing balance of €4,200/);
    // Once per ISO week: a showing later the same week gives the same keys.
    const later = cashClaims(
      owner,
      f,
      { connection_id: "conn" },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(later.map((c) => c.forecast_key)).toEqual(claims.map((c) => c.forecast_key));
  });

  it("records nothing when cash today is the owner's own figure, or there is no statement", () => {
    const stated = forecastCash(baseInputs());
    expect(cashClaims(owner, stated, { connection_id: "conn" }, NOW)).toEqual([]);
    const measured = forecastCash(
      baseInputs({ cash: { status: "known", fact: statement(TODAY) } }),
    );
    expect(cashClaims(owner, measured, null, NOW)).toEqual([]);
  });
});

const claim: ClaimRow = {
  kind: "cash_close",
  unit: "money",
  subject: "cash in the bank",
  subject_ref: { connection_id: "conn", source: "your bank statement", currency: "EUR" },
  metric: "cash.balance",
  window_start: "2026-11-02",
  window_end: "2026-11-08",
  low_minor: 400_000,
  high_minor: 500_000,
  currency: "EUR",
  low_num: null,
  high_num: null,
  low_date: null,
  high_date: null,
};
const on = (value: number, date = "2026-11-08"): DayValue[] => [{ id: "o1", date, value }];

describe("grading a week's closing balance", () => {
  it("inside, above and below, by the statement's balance on the week's last day", () => {
    expect(gradeCashClose(claim, on(450_000), "2026-11-20")).toMatchObject({
      verdict: "inside",
      actual_minor: 450_000,
      actual_date: "2026-11-08",
      actual_source: { table: "metric_observations", ids: ["o1"] },
    });
    const above = gradeCashClose(claim, on(512_000), "2026-11-20");
    expect(above?.verdict).toBe("above");
    expect(above?.actual_note).toMatch(/€120 over the top/);
    expect(gradeCashClose(claim, on(-5_000), "2026-11-20")?.verdict).toBe("below");
  });

  it("only that day counts: another day's balance doesn't grade it", () => {
    expect(gradeCashClose(claim, on(450_000, "2026-11-07"), "2026-11-20")).toBeNull();
  });

  it("waits up to six weeks for a statement covering the day, then says it can't tell", () => {
    expect(
      gradeCashClose(claim, [], addDays("2026-11-08", GRADE.cash_patience_days - 1)),
    ).toBeNull();
    const late = gradeCashClose(claim, [], addDays("2026-11-08", GRADE.cash_patience_days));
    expect(late?.verdict).toBe("cant_tell");
    expect(late?.actual_note).toMatch(/No bank statement covering 8 Nov 2026/);
  });
});
