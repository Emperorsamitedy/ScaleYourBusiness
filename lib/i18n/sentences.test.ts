// L-4b of TASKS-LANGUAGES.md — the sentences SYB builds from data, read in
// the real catalogues: a German cart headline with German money, Russian's
// three counting forms on the cash forecast's payout days, a Hungarian
// window line, and Chinese with full-width punctuation. The English of each
// is held byte for byte by the area's own tests (lib/*/words.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { CartsScreenView } from "../../app/api/carts/route";
import type { Measured } from "../../components/carts/carts-view";
import { cartsHeadline, windowLine } from "../../components/carts/carts-view";
import { dayRange } from "../cash/payout";
import type { AppLocale } from "./locales";
import { fullStop, listSep, oneStop } from "./punctuation";
import type { Tr } from "./tr";

function words(locale: AppLocale, namespace: string): { tr: Tr; locale: AppLocale } {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
  const t = createTranslator({
    locale,
    messages,
    namespace: namespace as "common",
  }) as unknown as Tr;
  return { tr: (k, v) => t(k, v), locale };
}

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
    value_left: [{ currency: "EUR", amount_minor: 123_450 }],
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

const ENGLISH_WORDS = /\b(the|your|carts?|left|days?|weeks?|and|of)\b/i;

describe("L-4b sentences in the real catalogues", () => {
  it("says the cart headline in German, with German money and no English", () => {
    const out = cartsHeadline(view, { ...words("de-DE", "cartsWords") });
    expect(out).toContain("1.234,50 €");
    expect(out).not.toMatch(ENGLISH_WORDS);
    expect(out).not.toBe(cartsHeadline(view));
  });

  it("counts the payout days with Russian's one, few and many", () => {
    const ru = words("ru-RU", "cashWords");
    expect(dayRange({ low: 1, high: 1 }, ru)).toBe("1 день");
    expect(dayRange({ low: 3, high: 3 }, ru)).toBe("3 дня");
    expect(dayRange({ low: 5, high: 5 }, ru)).toBe("5 дней");
    expect(dayRange({ low: 21, high: 21 }, ru)).toBe("21 день");
    // A range agrees with its upper end.
    expect(dayRange({ low: 2, high: 4 }, ru)).toBe("2-4 дня");
    expect(dayRange({ low: 2, high: 4 })).toBe("2 to 4 days");
  });

  it("says the window line in Hungarian, its dates in Hungarian", () => {
    const out = windowLine(measured, words("hu-HU", "cartsWords"));
    expect(out).not.toMatch(ENGLISH_WORDS);
    expect(out).toMatch(/szept|okt/);
    expect(out).not.toBe(windowLine(measured));
  });

  it("writes Chinese with full-width punctuation and its own figures", () => {
    const zh = { ...words("zh-Hans", "cartsWords") };
    const out = cartsHeadline(view, zh);
    expect(out).not.toMatch(ENGLISH_WORDS);
    expect(out).toMatch(/[一-鿿]/);
    expect(out).not.toMatch(/[,.;:?!](\s|$)/);
    expect(listSep("zh-Hans")).toBe("；");
    expect(fullStop("zh-Hans")).toBe("。");
    expect(listSep()).toBe("; ");
    expect(fullStop()).toBe(".");
  });

  it("keeps one full stop when a German date ends the sentence", () => {
    expect(oneStop("bis zum 20. Dez..", "de-DE")).toBe("bis zum 20. Dez.");
    expect(oneStop("Warten…", "de-DE")).toBe("Warten…");
    expect(oneStop("a... b", "de-DE")).toBe("a... b");
    expect(oneStop("odd.. but English", "en")).toBe("odd.. but English");
  });
});
