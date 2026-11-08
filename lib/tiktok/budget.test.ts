// TikTok Ads — budgets in TikTok's units, from SYB's minor units, and back.
import { describe, expect, it } from "vitest";
import {
  TIKTOK_BUDGET_CURRENCIES,
  UnknownTikTokCurrencyError,
  fromTikTokBudget,
  tiktokMinDailyMinor,
  toTikTokBudget,
} from "./budget";

describe("TikTok Ads — budget arithmetic", () => {
  it("EUR goes as euros with cents", () => {
    expect(toTikTokBudget(6050, "EUR")).toEqual({ value: 60.5, sent_minor: 6050 });
    expect(fromTikTokBudget(60.5, "EUR")).toBe(6050);
  });

  it("HUF goes in whole forints: the fillér are rounded off, and the guard sees what is sent", () => {
    expect(toTikTokBudget(150_049, "HUF")).toEqual({ value: 1500, sent_minor: 150_000 });
    expect(toTikTokBudget(150_050, "HUF")).toEqual({ value: 1501, sent_minor: 150_100 });
    expect(fromTikTokBudget(1500, "HUF")).toBe(150_000);
  });

  it("JPY and KRW are whole units already", () => {
    expect(toTikTokBudget(5000, "JPY")).toEqual({ value: 5000, sent_minor: 5000 });
    expect(TIKTOK_BUDGET_CURRENCIES["KRW"]).toEqual([1000, 0]);
  });

  it("a currency TikTok doesn't list is refused, never guessed", () => {
    expect(() => toTikTokBudget(1000, "XAF")).toThrow(UnknownTikTokCurrencyError);
    expect(() => tiktokMinDailyMinor("XAF")).toThrow(UnknownTikTokCurrencyError);
  });

  it("refuses a budget that isn't a whole positive amount", () => {
    expect(() => toTikTokBudget(0, "EUR")).toThrow(RangeError);
    expect(() => toTikTokBudget(10.5, "EUR")).toThrow(RangeError);
  });

  it("the campaign floor is 50 × the currency's ratio", () => {
    expect(tiktokMinDailyMinor("USD")).toBe(5000);
    expect(tiktokMinDailyMinor("EUR")).toBe(5000);
    expect(tiktokMinDailyMinor("HUF")).toBe(5000); // 50 Ft, in fillér
    expect(tiktokMinDailyMinor("JPY")).toBe(5000); // ratio 100 → ¥5,000
    expect(tiktokMinDailyMinor("PLN")).toBe(20000); // ratio 4 → 200 zł
  });
});
