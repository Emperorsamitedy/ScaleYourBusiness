// P5-08 — "money gets tight": the first week whose cautious end dips under
// the buffer, with its reason in words, and never a push to act.

import { describe, expect, it } from "vitest";
import { addDays } from "../seasons/forecast";
import { TODAY, baseInputs, cost, daily, eur } from "./fixtures";
import type { CashInputs, CashReady } from "./model";
import { forecastCash } from "./model";
import { PUSH_WORDS, clearedSentence, tightWeek } from "./warnings";

function ready(inputs: CashInputs): CashReady {
  const f = forecastCash(inputs);
  if (f.status !== "ready") throw new Error(f.headline);
  return f;
}

/** €100 a day, €5,000 today, a €2,000 buffer, rent on the 1st and a €9,000 VAT return in January. */
const vat = (over: Partial<CashInputs> = {}) =>
  baseInputs({
    revenue: daily(TODAY, 120, () => 10_000),
    costs: [cost("Rent", 1200, "monthly"), cost("VAT return", 9000, "quarterly")],
    ...over,
  });

describe("P5-08 — the first week whose LOW end dips under the buffer", () => {
  it("passes: the January VAT week is found, with the shortfall and its reasons", () => {
    const t = tightWeek(ready(vat()));
    expect(t?.index).toBe(9); // 1 Jan 2027 is day 66
    expect(t?.start).toBe(addDays(TODAY, 63));
    expect(t?.line).toBe(200_000);
    // 5,000 + 10 weeks × 700 − 3 × 1,200 − 9,000 = −600.
    expect(t?.balance.low).toBe(-60_000);
    expect(t?.shortfall).toBe(260_000);
    expect(t?.reasons).toEqual([
      "VAT return (€9,000, quarterly)",
      "your monthly costs on the 1st (€1,200)",
    ]);
    expect(t?.sentence).toBe(
      "Money could get tight in the week of 29 Dec: at the cautious end the balance is about −€600, under the €2,000 you want to keep; even at the hopeful end it is about −€600. Why: VAT return (€9,000, quarterly) and your monthly costs on the 1st (€1,200).",
    );
  });

  it("fails: no week under the buffer gives no warning", () => {
    expect(tightWeek(ready(vat({ costs: [cost("Rent", 1200, "monthly")] })))).toBeNull();
  });

  it("the cautious end only: a week whose low end sits exactly on the line isn't tight", () => {
    // Week 0: 5,000 + 700 − 1,200 = 4,500 — a buffer of exactly 4,500 is met, not dipped under.
    const at = ready(
      vat({ buffer: { status: "known", fact: eur(4500) }, costs: [cost("Rent", 1200, "monthly")] }),
    );
    expect(at.weeks[0]?.balance.low).toBe(450_000);
    expect(tightWeek(at)).toBeNull();
    const over = ready(
      vat({
        buffer: { status: "known", fact: eur(4500.01) },
        costs: [cost("Rent", 1200, "monthly")],
      }),
    );
    expect(tightWeek(over)?.index).toBe(0);
    expect(tightWeek(over)?.sentence).toMatch(/^Money could get tight this week:/);
  });

  it("with no buffer stated the line is an empty account, and the words say so", () => {
    const t = tightWeek(ready(vat({ buffer: { status: "missing" } })));
    expect(t?.line_kind).toBe("zero");
    expect(t?.sentence).toMatch(/below zero, an overdrawn account/);
  });

  it("a quiet stretch last year is part of the reason (season mode)", () => {
    const quietFrom = addDays(TODAY, -364 + 56);
    const quietTo = addDays(TODAY, -364 + 77);
    const series = daily(TODAY, 430, (day) => (day >= quietFrom && day < quietTo ? 3_000 : 10_000));
    const f = ready(vat({ revenue: series, cash: { status: "known", fact: eur(4000) } }));
    expect(f.pattern.kind).toBe("season");
    const t = tightWeek(f);
    expect(t?.index).toBe(9);
    expect(t?.reasons.at(-1)).toBe(
      "a quiet stretch (last year the same 2 weeks ran 0.3× your normal week)",
    );
  });

  it("a steady drain is named when nothing lumpy or quiet is due", () => {
    // €1 a parcel on 4,000 parcels a month: more goes out than the €700 a week brings in.
    const t = tightWeek(
      ready(
        vat({
          cash: { status: "known", fact: eur(3000) },
          costs: [cost("Box", 1, "per_job")],
          orders_month: { value: 4000, basis: "STATED", source: "as you told me" },
        }),
      ),
    );
    expect(t?.reasons).toHaveLength(1);
    expect(t?.reasons[0]).toMatch(
      /^about €\d+ a week more going out than coming in at the cautious end$/,
    );
  });
});

describe("P5-08 — never a push to act", () => {
  it("passes: no warning or cleared line uses push words", () => {
    const f = ready(vat());
    const t = tightWeek(f)!;
    expect(PUSH_WORDS.test(t.sentence)).toBe(false);
    expect(PUSH_WORDS.test(clearedSentence(f))).toBe(false);
  });

  it("fails: a planted push sentence is caught", () => {
    expect(PUSH_WORDS.test("You should move money from savings before then.")).toBe(true);
    expect(PUSH_WORDS.test("Consider chasing your late invoices.")).toBe(true);
  });

  it("the signature is stable for the same week and line, and moves when either does", () => {
    const a = tightWeek(ready(vat()))!;
    const b = tightWeek(ready(vat()))!;
    const c = tightWeek(ready(vat({ buffer: { status: "known", fact: eur(2500) } })))!;
    expect(a.signature).toBe(b.signature);
    expect(c.signature).not.toBe(a.signature);
  });
});

describe("P5-08 — the weekly summary carries the warning as something noticed", () => {
  it("lands under What I noticed, and adds nothing to Waiting for you", async () => {
    process.env.CONNECTOR_KEY ??=
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const { summarySections } = await import("../summary/compose");
    const { summaryWindow } = await import("../summary/week");
    const t = tightWeek(ready(vat()))!;
    const sections = summarySections({
      business: "Fernhill",
      window: summaryWindow(new Date("2026-10-27T06:00:00Z")),
      origin: "https://app.example",
      stop_url: "https://app.example/stop",
      activity: [
        { at: "2026-10-26T06:00:00Z", kind: "cash_warning", detail: t.sentence, meta: null },
      ],
      executed: [],
      pending: [],
      open_tickets: 0,
      readbacks: [],
      provider_labels: {},
    });
    expect(sections.map((s) => s.key)).toEqual(["noticed"]);
    expect(sections[0]?.lines[0]?.text).toBe(t.sentence);
  });
});
