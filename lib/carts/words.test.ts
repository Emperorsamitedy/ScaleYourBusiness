// L-4b — the sentences carts and the pipeline build from counts, through the
// "cartsWords" and "pipelineWords" catalogues. English through the default
// is English through the catalogue, byte for byte; a fake translator shows
// every sentence really goes through it, with figures and dates in the
// reader's locale.

import { describe, expect, it } from "vitest";
import type { CartsScreenView } from "../../app/api/carts/route";
import type { Measured } from "../../components/carts/carts-view";
import {
  cartsHeadline,
  checkoutConsentNotes,
  consentNotes,
  proposeBlock,
  sourcesLine,
  weekLine,
  windowLine,
} from "../../components/carts/carts-view";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import type { DealFacts } from "../pipeline/maths";
import { dueByForecast, weightedValue, winRate } from "../pipeline/maths";
import type { CartFact } from "./measure";
import { WIN_BACK, measureCarts, ruleOfThumb } from "./measure";

const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const de = { tr: fake, locale: "de-DE" as const };

const measured: Measured = {
  status: "measured",
  current: {
    from: "2026-09-29",
    to: "2026-10-28",
    started: 1_247,
    left: 41,
    recovered: 6,
    orders: 120,
    share_left: 41 / 161,
    value_left: [{ currency: "EUR", amount_minor: 123_400 }],
  },
  prior: null,
  prior_note: null,
  products: [],
  truncated: 0,
  reach: {
    shoppers: 41,
    emailable_shoppers: 9,
    carts: { emailable: 9, no_consent: 12, suppressed: 1, not_contact: 4, no_email: 15 },
  },
  win_back: [],
};

const view: CartsScreenView = {
  applies: true,
  today: "2026-10-29",
  sources: [{ label: "Shopify", read_at: "2026-10-29 06:00:00+00", carts: 52 }],
  measure: measured,
  thresholds: {
    window_days: 30,
    min_days: 14,
    min_carts: 10,
    winback_min_days: 1,
    winback_max_days: 7,
    recontact_days: 30,
  },
  reminder: {
    emailable: 0,
    in_segment: 5,
    recently_proposed: 0,
    unmatched_carts: 6,
    no_consent: 2,
    suppressed: 0,
  },
  checkout_consent: { said_yes: 4, withdrawn: 1, differs: 2 },
  proposal: null,
  held: null,
};

describe("carts sentences", () => {
  it("English through the default is the catalogue's English", () => {
    const en = { tr: englishTr("cartsWords"), locale: "en" as const };
    expect(cartsHeadline(view, en)).toBe(cartsHeadline(view));
    expect(windowLine(measured, en)).toBe(windowLine(measured));
    expect(cartsHeadline(view)).toBe(
      "€1,234 was left in carts in the last 30 days; 9 of the 41 shoppers can be emailed.",
    );
    expect(windowLine(measured)).toMatch(/^29 Sept? to 28 Oct: 1,247 checkouts started, 41 left/);
    expect(ruleOfThumb()).toEqual({ label: WIN_BACK.label, statement: WIN_BACK.statement });
  });

  it("goes through the translator, with figures and days in the reader's locale", () => {
    const all = [
      cartsHeadline(view, de),
      windowLine(measured, de),
      ...consentNotes(measured, null, de),
      ...checkoutConsentNotes(view, de),
      weekLine(view, de)!,
      proposeBlock(view, de)!,
      sourcesLine(view, de),
      ruleOfThumb(de).statement,
    ];
    for (const s of all) expect(s).toMatch(/^\[/);
    expect(all.join(" ")).not.toMatch(/ cart| was left|can be emailed|Carts and orders/);
    expect(cartsHeadline(view, de)).toMatch(/"money":"1\.234\s€"/);
    expect(windowLine(measured, de)).toContain('"from":"29. Sept."');
    expect(ruleOfThumb(de).statement).toMatch(/"high":"10\s%"/);
  });

  it("the refusals measureCarts words go through it too", () => {
    const cart = (day: string): CartFact => ({
      ref: day,
      day,
      completed: false,
      total_minor: 1_000,
      currency: "EUR",
      lines: [],
      lines_truncated: false,
      shopper: null,
      reach: "no_email",
    });
    const input = { today: "2026-10-29", carts: [cart("2026-10-20")], orders: [] };
    const en = measureCarts(input);
    expect(en.status === "refused" && en.reason).toBe(
      "Too little to measure yet: 9 days of carts (I need 14) and 1 cart left in the last 30 days (I need 10). It will be ready once 10 carts are left within 30 days, and not before 3 Nov.",
    );
    const m = measureCarts(input, de);
    expect(m.status === "refused" && m.reason).toMatch(
      /^\[measure\.thin\.reason .*"day":"3\. Nov\."/,
    );
  });
});

describe("pipeline sentences", () => {
  const TODAY = "2026-10-29";
  const deal = (over: Partial<DealFacts> = {}): DealFacts => ({
    id: "d1",
    stage: "qualified",
    stage_entered_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    closed_at: null,
    last_contact_at: null,
    value: { amount_minor: 480_000, currency: "EUR" },
    value_basis: "estimated",
    next_step: null,
    next_step_due: null,
    expected_close: "2026-11-10",
    ...over,
  });

  it("English through the default is the catalogue's English", () => {
    const en = { tr: englishTr("pipelineWords"), locale: "en" as const };
    const rate = winRate({ deals: [], stated: 30, today: TODAY });
    expect(winRate({ deals: [], stated: 30, today: TODAY }, en)).toEqual(rate);
    expect(rate.basis === "stated" && rate.assumed[0]).toBe(
      "your own win rate of 30% (question 6.1f), give or take 10 points: it's your estimate, not a measurement",
    );
    expect(weightedValue([deal()], rate, en)).toEqual(weightedValue([deal()], rate));
    // NOT_B2B (lib/pipeline/deals, which needs a database to import), word for word.
    expect(englishTr("pipelineWords")("hold.notB2b", { question: "6.1a" })).toBe(
      "Your pipeline is for businesses that sell to other businesses: you told me you sell to consumers (6.1a).",
    );
  });

  it("goes through the translator, with dates in the reader's locale", () => {
    const none = winRate({ deals: [], stated: null, today: TODAY }, de);
    expect(none.basis === "none" && none.reason).toMatch(/^\[rate\.none /);
    const w = weightedValue([deal()], none, de);
    expect(w.ok).toBe(false);
    if (!w.ok) {
      for (const s of [w.reason, ...w.can, ...w.cant, w.ready_when]) expect(s).toMatch(/^\[/);
    }
    const rate = winRate({ deals: [], stated: 30, today: TODAY }, de);
    expect(rate.basis === "stated" && rate.assumed[0]).toMatch(/"rate":"30\s%"/);
    const due = dueByForecast([deal()], rate, TODAY, de);
    expect(due.ok).toBe(true);
    if (due.ok) for (const s of [...due.sources, ...due.assumed]) expect(s).toMatch(/^\[/);
    const empty = dueByForecast([deal({ expected_close: null })], rate, TODAY, de);
    expect(!empty.ok && empty.reason).toContain('"day":"28. Nov. 2026"');
  });
});
