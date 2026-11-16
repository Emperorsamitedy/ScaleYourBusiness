// The idea check on the screen, in every locale: each kind of result renders
// with no key left raw, and no sentence anywhere in its words is a verdict
// on the idea (rule 36).

import "dotenv/config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import de from "../../messages/de-DE.json";
import en from "../../messages/en.json";
import es from "../../messages/es-ES.json";
import fr from "../../messages/fr-FR.json";
import hu from "../../messages/hu-HU.json";
import ru from "../../messages/ru-RU.json";
import zh from "../../messages/zh-Hans.json";
import type { IdeaAnswers } from "../../lib/ideas/check";
import { evaluateIdea } from "../../lib/ideas/check";
import { LOCALES } from "../../lib/i18n/locales";
import type { AppLocale } from "../../lib/i18n/locales";
import { trFor } from "../../lib/i18n/server-tr";
import { IdeaResultView } from "./IdeaResultView";

const BASE: IdeaAnswers = {
  sector: "restaurant",
  country: "HU",
  customer: "consumer",
  revenue_model: "one_off",
  currency: "HUF",
  price: 6_000,
  variable_cost: 2_400,
  customers_month: 400,
  fixed_month: 900_000,
  startup: 1_000_000,
  capital: 3_000_000,
  team: 3,
  ramp_months: 3,
};

const CASES: Record<string, IdeaAnswers> = {
  worked: BASE,
  unknownCustomers: { ...BASE, customers_month: null },
  short: { ...BASE, customers_month: 100 },
  losesPerSale: { ...BASE, variable_cost: 7_000 },
  runsOut: { ...BASE, capital: 1_200_000, ramp_months: 12 },
  business: {
    ...BASE,
    customer: "business",
    sector: "it_services",
    currency: "EUR",
    price: 900,
    variable_cost: 100,
    fixed_month: 4_000,
    startup: 3_000,
    capital: 20_000,
    customers_month: 12,
  },
  unmapped: { ...BASE, sector: "other" },
  outsideEu: { ...BASE, country: "GB", currency: "GBP" },
  recruitment: { ...BASE, revenue_model: "recruitment" },
};

const html = (a: IdeaAnswers, locale: AppLocale) =>
  renderToStaticMarkup(
    createElement(IdeaResultView, {
      result: evaluateIdea(a),
      answers: a,
      tr: trFor(locale, "ideas"),
      locale,
    }),
  );

describe("the idea check renders every kind of result, in every locale", () => {
  for (const [name, a] of Object.entries(CASES)) {
    it(name, () => {
      for (const locale of LOCALES) {
        const out = html(a, locale);
        expect(out, `${name} ${locale}`).not.toMatch(
          /\bresult\.[a-z_.]+|\{[a-z_]+\}|undefined|NaN/,
        );
      }
    });
  }

  it("says the numbers in English where a reader can check them", () => {
    const out = html(BASE, "en");
    expect(out).toContain("You cover your monthly costs from 250 customers a month.");
    expect(out).toContain("51.9%"); // three-year survival, restaurants in Hungary, 2020
    expect(out).toContain("bd_9bd_sz_cl_r2");
  });
});

// Rule 36: no verdict on an idea, in any language's words for the check.
const VERDICTS: Record<AppLocale, RegExp> = {
  en: /\b(good idea|bad idea|viable|will succeed|will fail|promising|chance of success|recommend(ed)? (it|this idea))\b/i,
  "de-DE":
    /(gute idee|schlechte idee|tragfähig|wird erfolgreich|wird scheitern|erfolgschance|vielversprechend)/i,
  "es-ES": /(buena idea|mala idea|viable|tendrá éxito|fracasará|probabilidad de éxito|prometedor)/i,
  "fr-FR": /(bonne idée|mauvaise idée|viable|réussira|échouera|chances de succès|prometteu)/i,
  "hu-HU": /(jó ötlet|rossz ötlet|életképes|sikeres lesz|el fog bukni|siker esélye|ígéretes)/i,
  "ru-RU":
    /(хорошая идея|плохая идея|жизнеспособн|будет успешн|провалится|шанс на успех|перспективн)/i,
  "zh-Hans": /(好主意|坏主意|可行性高|会成功|会失败|成功率|前景好)/,
};
const CATALOGUES: Record<AppLocale, { ideas?: unknown }> = {
  en,
  "de-DE": de,
  "es-ES": es,
  "fr-FR": fr,
  "hu-HU": hu,
  "ru-RU": ru,
  "zh-Hans": zh,
};

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("rule 36 — no verdict on an idea, in any locale", () => {
  for (const locale of LOCALES) {
    it(locale, () => {
      const words = strings(CATALOGUES[locale].ideas);
      expect(words.length).toBeGreaterThan(50);
      // The one sentence that says it isn't a verdict is allowed to name one.
      const offenders = words.filter(
        (s) =>
          VERDICTS[locale].test(s) &&
          s !== (CATALOGUES[locale].ideas as { result: { notVerdict: string } }).result.notVerdict,
      );
      expect(offenders).toEqual([]);
    });
  }
});
