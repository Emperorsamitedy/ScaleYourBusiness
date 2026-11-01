// I-54b — the pipeline's windowed forecast on the track record. What must hold:
//   · of the open deals expected to close in the next 30 days (past expected
//     dates included), the likely-won range is their total × the win rate's
//     low and high, per currency; deals with no value or no expected date are
//     counted, never guessed in; without a win rate it refuses (rule 25);
//   · it is recorded once per ISO week per currency, with the deals it covers;
//   · it is graded by the deals moved to won between the forecast and the end
//     of the window's last day, from their stage history, so reopening one
//     later doesn't undo it; a week's grace for late updates; an erased deal
//     or a won deal with no value in the currency makes it "can't tell".

import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { money } from "../core/money";
import type { DealFacts, WinRate } from "../pipeline/maths";
import { dueBy, dueByForecast } from "../pipeline/maths";
import { addDeal, updateDeal } from "../pipeline/deals";
import { cleanupBusinesses, freshBusiness } from "../pipeline/test-fixtures";
import { addDays } from "../seasons/forecast";
import { pipelineClaims } from "./claims";
import type { ClaimRow, DealOutcome } from "./grade";
import { GRADE, gradePipelineClose } from "./grade";
import { gradeOne } from "./run";

afterAll(async () => {
  await cleanupBusinesses();
});

const TODAY = "2026-11-02";
const rate: WinRate = {
  basis: "stated",
  point: 0.3,
  low: 0.2,
  high: 0.4,
  closed: { won: 0, lost: 0, from: "2025-11-02", to: TODAY },
  stated: 30,
  needed: 5,
  assumed: ["your own win rate of 30%, give or take 10 points"],
};
let n = 0;
const deal = (over: Partial<DealFacts> = {}): DealFacts => ({
  id: `d${++n}`,
  stage: "proposal_sent",
  stage_entered_at: "2026-10-01T09:00:00Z",
  created_at: "2026-09-01T09:00:00Z",
  closed_at: null,
  last_contact_at: null,
  value: money(1_000_000, "EUR"),
  value_basis: "quoted",
  next_step: null,
  next_step_due: null,
  expected_close: "2026-11-20",
  ...over,
});

describe("the forecast", () => {
  it("weighs the deals due in 30 days, overdue ones included, and counts what it leaves out", () => {
    const f = dueByForecast(
      [
        deal(),
        deal({ expected_close: "2026-10-25", value: money(500_000, "EUR") }), // overdue, still open
        deal({ expected_close: "2026-12-20" }), // after the window
        deal({ expected_close: null }), // no date
        deal({ value: null }), // no value
        deal({ stage: "won", closed_at: "2026-10-30T10:00:00Z" }), // already closed
      ],
      rate,
      TODAY,
    );
    expect(dueBy(TODAY)).toBe("2026-12-02");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]!.total).toEqual(money(1_500_000, "EUR"));
    expect(f.lines[0]!.low.amount_minor).toBe(300_000);
    expect(f.lines[0]!.high.amount_minor).toBe(600_000);
    expect(f).toMatchObject({ unvalued: 1, overdue: 1, undated: 1, basis: "stated" });
    expect(f.assumed.join(" ")).toMatch(/expected earlier and is still open/);
  });

  it("refuses without a win rate, and when nothing due has a value", () => {
    const none: WinRate = {
      basis: "none",
      closed: { won: 0, lost: 0, from: "", to: "" },
      needed: 5,
      reason: "I don't know your win rate yet",
    };
    expect(dueByForecast([deal()], none, TODAY)).toMatchObject({ ok: false });
    expect(dueByForecast([deal({ expected_close: null })], rate, TODAY)).toMatchObject({
      ok: false,
      undated: 1,
    });
  });

  it("keeps each currency apart", () => {
    const f = dueByForecast([deal(), deal({ value: money(2_000_000, "HUF") })], rate, TODAY);
    expect(f.ok && f.lines.map((l) => l.currency)).toEqual(["EUR", "HUF"]);
  });
});

const owner = { account_id: "a", profile_id: "p" };
const NOW = new Date(`${TODAY}T10:00:00Z`);

describe("the claim", () => {
  it("is the range shown, with its deals, once per ISO week per currency", () => {
    const f = dueByForecast([deal({ id: "x1" }), deal({ id: "x2" })], rate, TODAY);
    const [c] = pipelineClaims(owner, f, TODAY, NOW);
    expect(c).toMatchObject({
      kind: "pipeline_close",
      unit: "money",
      currency: "EUR",
      window_start: TODAY,
      window_end: "2026-12-02",
      low_minor: 400_000,
      high_minor: 800_000,
    });
    expect(c!.subject_ref).toMatchObject({
      deals: [
        { id: "x1", amount_minor: 1_000_000 },
        { id: "x2", amount_minor: 1_000_000 },
      ],
    });
    const later = pipelineClaims(owner, f, TODAY, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(later[0]!.forecast_key).toBe(c!.forecast_key);
    expect(
      pipelineClaims(owner, { ok: false, by: "x", reason: "r", undated: 0 }, TODAY, NOW),
    ).toEqual([]);
  });
});

const claim: ClaimRow = {
  kind: "pipeline_close",
  unit: "money",
  subject: "deals won",
  subject_ref: { deals: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  metric: "deals.won",
  window_start: TODAY,
  window_end: "2026-12-02",
  low_minor: 400_000,
  high_minor: 800_000,
  currency: "EUR",
  low_num: null,
  high_num: null,
  low_date: null,
  high_date: null,
};
const out = (over: Partial<DealOutcome>): DealOutcome => ({
  id: "a",
  won_at: null,
  event_id: null,
  value_minor: 1_000_000,
  gone: false,
  ...over,
});
const graded = addDays("2026-12-02", GRADE.pipeline_settle_days);

describe("grading", () => {
  it("adds up the deals marked won by the day, against the range", () => {
    const g = gradePipelineClose(
      claim,
      [
        out({ won_at: "2026-11-10T10:00:00Z", event_id: "e1", value_minor: 600_000 }),
        out({ id: "b" }),
        out({ id: "c" }),
      ],
      graded,
    );
    expect(g).toMatchObject({
      verdict: "inside",
      actual_minor: 600_000,
      actual_source: { table: "deal_events", ids: ["e1"] },
    });
    expect(g?.actual_note).toMatch(/^1 of the 3 deals was marked won by 2 Dec 2026/);
    expect(gradePipelineClose(claim, [out({}), out({ id: "b" })], graded)?.verdict).toBe("below");
    expect(
      gradePipelineClose(
        claim,
        [out({ won_at: "x", event_id: "e1" }), out({ id: "b", won_at: "y", event_id: "e2" })],
        graded,
      )?.verdict,
    ).toBe("above");
  });

  it("waits a week for late updates, and can't tell with an erased deal or a won one with no value", () => {
    expect(gradePipelineClose(claim, [out({})], addDays(graded, -1))).toBeNull();
    expect(gradePipelineClose(claim, [out({ gone: true })], graded)?.verdict).toBe("cant_tell");
    expect(
      gradePipelineClose(claim, [out({ won_at: "x", event_id: "e", value_minor: null })], graded)
        ?.verdict,
    ).toBe("cant_tell");
  });
});

describe("grading reads the deals' own stage history", () => {
  it("a deal won in the window counts even when reopened later; one won before the forecast doesn't", async () => {
    const s = await freshBusiness();
    const made = new Date("2026-11-02T08:00:00Z");
    const add = (title: string) =>
      addDeal(
        s.account_id,
        s.profile_id,
        {
          contact: { name: `Buyer ${title}` },
          title,
          stage: "proposal_sent",
          value: { amount_minor: 1_000_000, currency: "EUR", basis: "quoted" },
          expected_close: "2026-11-20",
        },
        undefined,
        new Date("2026-10-01T08:00:00Z"),
      );
    const won = await add("won and reopened");
    const early = await add("won before");
    const open = await add("still open");
    await updateDeal(s.account_id, early.id, { stage: "won" }, new Date("2026-11-01T08:00:00Z"));
    await updateDeal(s.account_id, won.id, { stage: "won" }, new Date("2026-11-15T08:00:00Z"));
    await updateDeal(
      s.account_id,
      won.id,
      { stage: "qualified" },
      new Date("2026-11-25T08:00:00Z"),
    );
    const row = {
      ...claim,
      id: crypto.randomUUID(),
      account_id: s.account_id,
      profile_id: s.profile_id,
      forecast_key: "test",
      made_at: made.toISOString(),
      recorded_at: made.toISOString(),
      subject_ref: { deals: [{ id: won.id }, { id: early.id }, { id: open.id }] },
      low_minor: 300_000,
      high_minor: 1_200_000,
      claim: "test",
      basis: "test",
      graded_at: null,
      verdict: null,
      actual_minor: null,
      actual_num: null,
      actual_date: null,
      actual_note: null,
      actual_source: null,
    };
    const g = await gradeOne(row, graded);
    expect(g).toMatchObject({ verdict: "inside", actual_minor: 1_000_000 });
    expect(g?.actual_note).toMatch(/^1 of the 3 deals was marked won/);
    // Not graded while the week's grace runs.
    expect(await gradeOne(row, addDays(graded, -1))).toBeNull();
  });
});
