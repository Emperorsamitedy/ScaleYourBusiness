// L-4b: the sentences lib/simulate builds from the numbers come from the
// "simulateWords" catalogue — English by default, exactly the code's own
// words — and go through whatever translator the screen passes, with every
// figure in the reader's locale.

import { describe, expect, it } from "vitest";
import type { Tr } from "../i18n/tr";
import { full } from "./fixtures";
import type { OptionResult, SimOption } from "./model";
import { compareOptions, simulateOption } from "./model";
import type { PriceItemRaw } from "./pricing";
import { breakEven, comparePrices, pricingHeadline, simulatePrice } from "./pricing";
import { serviceItems } from "./pricing-items";
import type { SimText } from "./words";
import { SIM_WORDS, englishSimText } from "./words";
import { englishTr } from "../i18n/tr";

/** A translator that leaves no English: the key, and its values, in brackets. */
const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const german: SimText = { tr: fake, locale: "de-DE" };
/** Intl's no-break space between a figure and its unit. */
const NB = " ";

const RAISE: SimOption = { kind: "ads", change: "raise", campaign_ref: "120000001", share: 0.2 };
const EMAIL: SimOption = { kind: "email", segment: "lapsed" };

const mug = (): PriceItemRaw => ({
  key: "offer:mug",
  kind: "offer",
  name: "Speckled Everyday Mug",
  currency: "EUR",
  price: { amount_minor: 123_400, currency: "EUR", basis: "STATED", source: "as you told me" },
  unit_cost: { amount_minor: 40_000, currency: "EUR", basis: "STATED", source: "as you told me" },
  volume: { value: 350, basis: "STATED", source: "as you told me" },
  capacity: null,
  asks: { price: "/a", unit_cost: "/a", volume: "/a", capacity: null },
});

/** Every sentence an option carries. */
function sentences(r: OptionResult): string[] {
  const out = [r.title, r.what, r.worst_words];
  for (const i of r.inputs) out.push(i.label, i.label_inline, i.source, i.needs ?? "");
  for (const a of r.assumptions) out.push(a.statement, a.source);
  for (const c of Object.values(r.measures)) {
    if (c.status === "range") out.push(c.formula);
    else if (c.status === "missing") out.push(...c.needs);
    else out.push(c.why);
  }
  if (r.key_rate) out.push(r.key_rate.label);
  if (!r.proposable.ok) out.push(r.proposable.why);
  return out.filter((s) => s !== "");
}

describe("the English is the catalogue's, and the code's", () => {
  it("the default and englishTr say the same words", () => {
    const tr = englishTr(SIM_WORDS);
    const r = simulateOption(EMAIL, full());
    expect(r.title).toBe(tr("model.email.title", { segment: "lapsed" }));
    expect(r.title).toBe("Win-back email to lapsed customers");
    expect(r.inputs.find((i) => i.key === "margin")!.label).toBe(tr("model.label.margin"));
    expect(r.inputs.find((i) => i.key === "margin")!.label_inline).toBe("your margin");
    expect(simulateOption(RAISE, full()).title).toBe('Raise "Campaign 120000001" by 20%');
    expect(simulateOption(RAISE, full(), englishSimText()).title).toBe(
      simulateOption(RAISE, full()).title,
    );
    const be = breakEven(mug(), 135_740);
    expect(be.words).toBe(
      "A 10% rise pays as long as you lose fewer than 46 of your ~350 sales a month (12.9%).",
    );
  });
});

describe("every sentence goes through the translator", () => {
  it("leaves no English in an option, and formats its figures in German", () => {
    for (const o of [EMAIL, RAISE, { kind: "content" } as SimOption]) {
      const r = simulateOption(o, full(), german);
      for (const s of sentences(r)) expect(s, s).toMatch(/^\[/);
    }
    const r = simulateOption(RAISE, full(), german);
    const cost = r.measures.cost;
    if (cost.status !== "range") throw new Error(cost.status);
    // German money and percent, passed into the message as figures.
    expect(cost.formula).toContain(`"daily":"10${NB}€"`);
    expect(cost.formula).toContain(`"change":"+20${NB}%"`);
  });

  it("words the currency note with the language's list", () => {
    const x = full();
    const cmp = compareOptions(
      [EMAIL, { kind: "ads", change: "new", daily_budget_minor: 1_000, currency: "HUF" }],
      x,
      german,
    );
    expect(cmp.rows.find((r) => r.measure === "revenue")!.note).toBe(
      '[model.currencies {"currencies":"EUR und HUF"}]',
    );
  });

  it("routes what-if pricing through it too, with German money", () => {
    const r = simulatePrice(mug(), { kind: "share", share: 0.1 }, "shop", german);
    expect(r.title).toBe(`[pricing.title.share {"change":"+10${NB}%","price":"1.357,40${NB}€"}]`);
    expect(r.breakeven.words).toMatch(/^\[pricing\.be\.loseCount /);
    expect(r.worst_words).toContain('"amount":"');
    for (const i of r.inputs) {
      expect(i.label).toMatch(/^\[/);
      expect(i.source === "as you told me" || i.source.startsWith("[")).toBe(true);
    }
    const cmp = comparePrices(mug(), [{ kind: "share", share: 0.5 }], "shop", german);
    expect(cmp.refused[0]!.why).toBe(`[pricing.refuse.tooBig {"share":"30${NB}%"}]`);
    expect(pricingHeadline({ ...cmp, results: [] }, german)).toMatch(/^\[pricing\.headPick /);
    const [cut] = serviceItems(
      {
        rows: [{ service: "Cut", status: "completed", price_minor: 3000, currency: "EUR" }],
        from: "2026-10-01",
        to: "2026-10-28",
        source: "Square",
        capacityPerWeek: 30,
        offers: [],
      },
      german,
    );
    // The dates in the reader's own form; the brand name as it is.
    expect(cut!.price!.source).toContain('"from":"1. Okt. 2026"');
    expect(cut!.price!.source).toContain('"source":"Square"');
  });
});
