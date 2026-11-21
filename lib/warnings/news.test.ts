// Warnings sent at once: an alert is for news. Each rule with a case that
// is news and a case that is not.

import { describe, expect, it } from "vitest";
import { cashIsNews, stockIsNews } from "./news";

const week = (start: string, end: string) => ({ week_start: start, week_end: end });
const stood = (start: string, end: string) => ({ ...week(start, end), cleared: false });

describe("a stock warning is news unless the item was just said, as badly or worse", () => {
  const mug = { key: "sku:mug", level: "tight" };

  it("is news the first time an item is said", () => {
    expect(stockIsNews([], mug)).toBe(true);
    expect(stockIsNews([{ key: "sku:plate", level: "before_restock" }], mug)).toBe(true);
  });

  it("is not news when the week turns and the same warning is said again", () => {
    expect(stockIsNews([mug], mug)).toBe(false);
  });

  it("is news when it got worse: now it runs out before the delivery even at best", () => {
    expect(stockIsNews([mug], { ...mug, level: "before_restock" })).toBe(true);
  });

  it("is not news when it eased from worse to tight", () => {
    expect(stockIsNews([{ ...mug, level: "before_restock" }], mug)).toBe(false);
  });

  it("is not news when the line does not say which item it is about", () => {
    expect(stockIsNews([], { key: null, level: "tight" })).toBe(false);
  });
});

describe("a cash warning is news when nothing stood, or it is a different squeeze", () => {
  const dec29 = week("2026-12-29", "2027-01-04");

  it("is news when no warning was said before", () => {
    expect(cashIsNews(null, dec29)).toBe(true);
  });

  it("is news when the last line said the warning had cleared", () => {
    expect(cashIsNews({ cleared: true, week_start: null, week_end: null }, dec29)).toBe(true);
  });

  it("is not news when the same week is said again, counted from another day", () => {
    // Said on a Wednesday, the week holding the bill ran 30 Dec to 5 Jan.
    expect(cashIsNews(stood("2026-12-30", "2027-01-05"), dec29)).toBe(false);
    expect(cashIsNews(stood("2026-12-29", "2027-01-04"), dec29)).toBe(false);
  });

  it("is not news when the squeeze carries on into the week after", () => {
    expect(cashIsNews(stood("2026-12-22", "2026-12-28"), dec29)).toBe(false);
    // Said from a Wednesday, the week that stood ended six days before this one begins.
    expect(cashIsNews(stood("2026-12-17", "2026-12-23"), dec29)).toBe(false);
  });

  it("is news when the tight week now comes wholly sooner than the one that stood", () => {
    expect(cashIsNews(stood("2027-01-19", "2027-01-25"), dec29)).toBe(true);
  });

  it("is news when it is a later squeeze, with a clear week between", () => {
    expect(cashIsNews(stood("2026-12-15", "2026-12-21"), dec29)).toBe(true);
    expect(cashIsNews(stood("2026-12-01", "2026-12-07"), dec29)).toBe(true);
  });

  it("is not news when either line lacks its week", () => {
    expect(cashIsNews(null, { week_start: null, week_end: null })).toBe(false);
    expect(cashIsNews({ cleared: false, week_start: null, week_end: null }, dec29)).toBe(false);
    expect(cashIsNews(stood("not a day", "2026-12-07"), dec29)).toBe(false);
  });
});
