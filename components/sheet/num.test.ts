import { describe, expect, it } from "vitest";
import { delta, moneyExact, moneyFig, moneyText, num } from "./num";

const NB = ",";

describe("sheet number grammar", () => {
  it("groups thousands with a comma and keeps fixed decimals", () => {
    expect(num(1234567)).toBe(`1${NB}234${NB}567`);
    expect(num(38.4, 1)).toBe("38.4");
    expect(num(38, 1)).toBe("38.0");
  });

  it("uses a true minus, and never prints minus zero", () => {
    expect(num(-2100)).toBe(`−2${NB}100`);
    expect(num(-0.01, 1)).toBe("0.0");
  });

  it("formats money from integer minor units by the currency's exponent", () => {
    expect(moneyFig(210000, "EUR")).toBe(`2${NB}100`);
    expect(moneyFig(409000, "HUF")).toBe(`4${NB}090`);
    expect(moneyFig(1500, "JPY")).toBe(`1${NB}500`); // exponent 0, not /100
    expect(moneyFig(740, "EUR", 2)).toBe("7.40");
  });

  it("puts the unit on prose money, with decimals only when needed", () => {
    expect(moneyText(29000, "eur")).toBe("€290");
    expect(moneyText(4950, "EUR")).toBe("€49.50");
    expect(moneyText(409000, "HUF")).toBe(`4${NB}090 HUF`);
  });

  it("signs deltas", () => {
    expect(delta(2.14)).toBe("+2.1");
    expect(delta(-0.4)).toBe("−0.4");
    expect(delta(0.01)).toBe("0.0");
  });

  it("prints ledger money at the currency's full decimals", () => {
    expect(moneyExact(29000, "eur")).toBe("€290.00");
    expect(moneyExact(1500, "JPY")).toBe("1,500 JPY");
  });
});
