// L-1: the status gate (rule 6 of TASKS-LANGUAGES.md), the reviewer
// allowlist, and the formatting edge (rule 3) — pure, every rule with a
// passing and a failing case.

import { describe, expect, it } from "vitest";
import { moneyExact, moneyFig, moneyText, num, delta } from "../../components/sheet/num";
import { dateWords as benchDate } from "../../components/benchmarks/view";
import { longDate } from "../../components/patterns/patterns-view";
import {
  dateWords as pipeDate,
  dayWords as pipeDay,
} from "../../components/pipeline/pipeline-view";
import { dayWords as cartDay } from "../carts/measure";
import { shortDate } from "../charts/model";
import { format, money } from "../core/money";
import { ISO_4217_CODES, isIsoCurrency } from "../core/currencies";
import {
  DEFAULT_LOCALE,
  LANGUAGE_NAMES,
  LANGUAGE_STATUS,
  LOCALES,
  isAppLocale,
  languageOpenTo,
  languageStatus,
  offeredLanguages,
  resolveLanguage,
} from "./locales";
import { dayMonth, dayMonthYear, monthYear } from "./format";
import { currencyOptions, languageOptions, readPendingChoices } from "./picker";
import { isLanguageReviewer, parseReviewAllowlist } from "./review";

describe("the languages and their status", () => {
  it("speaks the seven the owner chose, English first and the default", () => {
    expect(LOCALES).toEqual(["en", "es-ES", "de-DE", "fr-FR", "hu-HU", "ru-RU", "zh-Hans"]);
    expect(DEFAULT_LOCALE).toBe("en");
    for (const l of LOCALES) expect(LANGUAGE_NAMES[l].length).toBeGreaterThan(0);
  });

  it("has every language live (the owner's override of 2026-11-08, before native review)", () => {
    for (const l of LOCALES) expect(LANGUAGE_STATUS[l], l).toBe("live");
  });

  it("knows its own locales and nothing else", () => {
    expect(isAppLocale("zh-Hans")).toBe(true);
    for (const v of ["zh", "zh-CN", "de", "EN", "", null, 3]) expect(isAppLocale(v)).toBe(false);
  });

  it("offers every customer all seven languages now that all are live", () => {
    expect(offeredLanguages(false)).toEqual([...LOCALES]);
    expect(offeredLanguages(true)).toEqual([...LOCALES]);
    expect(languageOpenTo("de-DE", false)).toBe(true);
    expect(languageOpenTo("en", false)).toBe(true);
  });

  it("falls back to English for anything that isn't one of its languages", () => {
    expect(resolveLanguage("ru-RU", true)).toBe("ru-RU");
    expect(resolveLanguage("ru-RU", false)).toBe("ru-RU");
    expect(resolveLanguage("klingon", true)).toBe("en");
    expect(resolveLanguage(undefined, true)).toBe("en");
  });

  it("marks review languages in the picker, so a reviewer knows what is unchecked", () => {
    expect(languageOptions(offeredLanguages(true)).filter((o) => o.checking)).toHaveLength(0);
    process.env.LANGUAGES_IN_REVIEW = "ru-RU, zh-Hans,en";
    try {
      // The owner's lever: two sent back to review; English never is.
      expect(languageOptions(offeredLanguages(true)).filter((o) => o.checking)).toHaveLength(2);
      expect(offeredLanguages(false)).toEqual(["en", "es-ES", "de-DE", "fr-FR", "hu-HU"]);
    } finally {
      delete process.env.LANGUAGES_IN_REVIEW;
    }
    expect(languageOptions(["en"])).toEqual([{ code: "en", name: "English", checking: false }]);
  });

  it("reads LANGUAGES_IN_REVIEW as typed by hand: case, spaces and _ forgiven, unknown codes ignored", () => {
    process.env.LANGUAGES_IN_REVIEW = " zh-hans ,RU_ru,klingon,, EN ";
    try {
      expect(languageStatus("zh-Hans")).toBe("review");
      expect(languageStatus("ru-RU")).toBe("review");
      expect(languageStatus("de-DE")).toBe("live");
      // English is the source: never sent back, whatever is typed.
      expect(languageStatus("en")).toBe("live");
      expect(offeredLanguages(false)).toEqual(["en", "es-ES", "de-DE", "fr-FR", "hu-HU"]);
      expect(resolveLanguage("zh-Hans", false)).toBe("en");
    } finally {
      delete process.env.LANGUAGES_IN_REVIEW;
    }
    expect(languageStatus("zh-Hans")).toBe("live");
  });
});

describe("the reviewer allowlist (LANGUAGE_REVIEW_ACCOUNTS)", () => {
  const id = "3f6b1c1e-1111-4222-8333-944445555666";

  it("reads account ids and email addresses, ignoring case, spaces and blanks", () => {
    const list = parseReviewAllowlist(` Owner@Example.com ,, ${id.toUpperCase()} , `);
    expect([...list.emails]).toEqual(["owner@example.com"]);
    expect([...list.accounts]).toEqual([id]);
    expect(parseReviewAllowlist(undefined).emails.size).toBe(0);
  });

  it("names a signed-in person a reviewer by their address or their business", () => {
    const who = { account_id: id, email: "reviewer@example.com" };
    expect(isLanguageReviewer(who, "REVIEWER@example.com")).toBe(true);
    expect(isLanguageReviewer(who, id)).toBe(true);
    expect(
      isLanguageReviewer(who, "someone@example.com, 00000000-0000-0000-0000-000000000000"),
    ).toBe(false);
    expect(isLanguageReviewer(who, "")).toBe(false);
    expect(isLanguageReviewer(null, "reviewer@example.com")).toBe(false);
  });
});

describe("the first step's choices in cookies", () => {
  it("takes only real languages and ISO 4217 currencies", () => {
    expect(readPendingChoices("de-DE", "EUR")).toEqual({
      language: "de-DE",
      currency: "EUR",
      chosen: true,
    });
    expect(readPendingChoices("xx", "VAT")).toEqual({
      language: null,
      currency: null,
      chosen: false,
    });
    expect(readPendingChoices(undefined, "eur").currency).toBeNull();
  });

  it("offers every active ISO 4217 currency, each named in the reader's language", () => {
    const en = currencyOptions("en");
    expect(en).toHaveLength(ISO_4217_CODES.length);
    expect(en.every((c) => isIsoCurrency(c.code))).toBe(true);
    expect(en.find((c) => c.code === "HUF")?.name).toBe("Hungarian Forint");
    expect(currencyOptions("de-DE").find((c) => c.code === "HUF")?.name).toBe("Ungarischer Forint");
    expect(currencyOptions("zh-Hans").find((c) => c.code === "JPY")?.name).toBe("日元");
  });
});

describe("figures in the reader's language (rule 3)", () => {
  it("keeps today's English output exactly when no language is given, or English is", () => {
    expect(num(12345.6, 1)).toBe("12,345.6");
    expect(num(-4, 0, "en")).toBe("−4");
    expect(moneyText(29_000, "EUR")).toBe("€290");
    expect(moneyText(409_000, "HUF", "en")).toBe("4,090 HUF");
    expect(moneyExact(29_000, "EUR")).toBe("€290.00");
    expect(moneyFig(214_000, "EUR")).toBe("2,140");
    expect(delta(2.1)).toBe("+2.1");
  });

  it("writes money the way each language writes it, always naming the currency", () => {
    const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
    expect(nb(moneyExact(123_456, "EUR", "de-DE"))).toBe("1.234,56 €");
    expect(nb(moneyExact(123_456, "EUR", "fr-FR"))).toBe("1 234,56 €");
    expect(nb(moneyText(409_000, "HUF", "hu-HU"))).toBe("4090 Ft");
    expect(nb(moneyText(1_200, "JPY", "zh-Hans"))).toBe("JP¥1,200");
    expect(nb(moneyText(150, "USD", "ru-RU"))).toBe("1,50 $");
    expect(nb(num(1234567, 0, "ru-RU"))).toBe("1 234 567");
    expect(nb(delta(2.5, 1, "de-DE"))).toBe("+2,5");
  });

  it("formats from integer minor units at the currency's exponent, never converting", () => {
    // ¥ has no minor unit and the dinar three: the same integer means different amounts.
    expect(moneyExact(1_234, "JPY", "de-DE")).toContain("1.234");
    expect(moneyExact(1_234, "KWD", "de-DE")).toContain("1,234");
    expect(moneyExact(1_234, "KWD", "de-DE")).toContain("KWD");
    expect(format(money(123_456, "EUR"), "de-DE").replace(/\u00a0/g, " ")).toBe("1.234,56 €");
  });

  it("dates days in each language, and in English as before", () => {
    expect(shortDate("2026-10-03")).toBe("3 Oct");
    expect(cartDay("2026-11-06")).toBe("6 Nov");
    expect(pipeDay("2026-11-06")).toBe("6 Nov");
    expect(benchDate("2026-09-30")).toBe("30 Sep 2026");
    expect(longDate("2025-10-04")).toBe("4 Oct 2025");
    expect(pipeDate("2025-10-28")).toBe("28 Oct 2025");
    expect(shortDate("2026-10-03", "de-DE")).toBe("3. Okt.");
    expect(cartDay("2026-11-06", "fr-FR")).toBe("6 nov.");
    expect(shortDate("2026-10-03", "zh-Hans")).toBe("10月3日");
    expect(benchDate("2026-09-30", "hu-HU")).toBe("2026. szept. 30.");
    expect(longDate("2025-10-04", "ru-RU")).toBe("4 окт. 2025 г.");
    expect(pipeDate("2025-10-28", "es-ES")).toBe("28 oct 2025");
    // The guard still holds: a malformed day is returned as it came.
    expect(benchDate("not-a-date", "de-DE")).toBe("not-a-date");
  });

  it("leaves a malformed day as it came in every language, never throwing", () => {
    for (const locale of LOCALES) {
      expect(dayMonth("not-a-date", locale)).toBe("not-a-date");
      expect(dayMonthYear("", locale)).toBe("");
      expect(monthYear("2026-13-01", locale)).toBe("2026-13-01");
    }
    expect(dayMonthYear("2026-11-06", "de-DE")).toMatch(/6\. Nov\.? 2026/);
    expect(dayMonthYear("2026-09-29", "en")).toBe("29 Sep 2026");
  });
});
