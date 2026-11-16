import { describe, expect, it } from "vitest";
import { leakBars, worthBars } from "./statement-bars";

const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });
const huf = (amount_minor: number) => ({ amount_minor, currency: "HUF" });

describe("worthBars", () => {
  it("draws verified, losses, the fee and after-fee on one scale, signs kept in the money", () => {
    const [block, ...rest] = worthBars({
      verified: [eur(120_000)],
      losses: [eur(-30_000)],
      fee: [eur(4_900)],
      net_of_fee: [eur(115_100)],
    });
    expect(rest).toEqual([]);
    expect(block).toEqual({
      currency: "EUR",
      max: 120_000,
      rows: [
        { key: "verified", money: eur(120_000), value: 120_000, tone: "ok" },
        { key: "losses", money: eur(-30_000), value: 30_000, tone: "alarm" },
        { key: "fee", money: eur(4_900), value: 4_900, tone: "hollow" },
        { key: "net", money: eur(115_100), value: 115_100, tone: "ink" },
      ],
    });
  });

  it("draws a month that lost money as lost, at its unsigned length", () => {
    const [block] = worthBars({
      verified: [eur(-20_000)],
      losses: [eur(-20_000)],
      fee: [eur(4_900)],
      net_of_fee: [eur(-24_900)],
    });
    expect(block?.rows.map((r) => [r.key, r.value, r.tone])).toEqual([
      ["verified", 20_000, "alarm"],
      ["losses", 20_000, "alarm"],
      ["fee", 4_900, "hollow"],
      ["net", 24_900, "alarm"],
    ]);
    expect(block?.max).toBe(24_900);
  });

  it("leaves the fee and after-fee rows out when nothing was charged", () => {
    const [block] = worthBars({
      verified: [eur(50_000)],
      losses: [],
      fee: [],
      net_of_fee: [eur(50_000)],
    });
    expect(block?.rows.map((r) => [r.key, r.money])).toEqual([
      ["verified", eur(50_000)],
      ["losses", null],
    ]);
  });

  it("keeps each currency on its own scale, the fee only where it was charged", () => {
    const blocks = worthBars({
      verified: [huf(9_000_000)],
      losses: [],
      fee: [eur(4_900)],
      net_of_fee: [eur(-4_900), huf(9_000_000)],
    });
    expect(blocks.map((b) => [b.currency, b.max, b.rows.map((r) => r.key)])).toEqual([
      ["EUR", 4_900, ["verified", "losses", "fee", "net"]],
      ["HUF", 9_000_000, ["verified", "losses", "net"]],
    ]);
  });

  it("gives nothing to draw for an empty month, or one of zeros", () => {
    expect(worthBars({ verified: [], losses: [], fee: [], net_of_fee: [] })).toEqual([]);
    expect(worthBars({ verified: [eur(0)], losses: [], fee: [], net_of_fee: [eur(0)] })).toEqual(
      [],
    );
  });
});

describe("leakBars", () => {
  it("puts each currency's ranges on one scale, in the order given", () => {
    expect(
      leakBars([
        { key: "a", currency: "EUR", low_minor: 12_000, high_minor: 48_000 },
        { key: "b", currency: "HUF", low_minor: 100_000, high_minor: 100_000 },
        { key: "c", currency: "EUR", low_minor: 5_000, high_minor: 9_000 },
      ]),
    ).toEqual([
      {
        currency: "EUR",
        max: 48_000,
        rows: [
          { key: "a", low: 12_000, value: 48_000 },
          { key: "c", low: 5_000, value: 9_000 },
        ],
      },
      { currency: "HUF", max: 100_000, rows: [{ key: "b", low: 100_000, value: 100_000 }] },
    ]);
  });

  it("leaves out a range that crosses zero", () => {
    expect(
      leakBars([
        { key: "a", currency: "EUR", low_minor: -89_500, high_minor: 46_100 },
        { key: "b", currency: "EUR", low_minor: 13_400, high_minor: 123_800 },
      ]),
    ).toEqual([
      { currency: "EUR", max: 123_800, rows: [{ key: "b", low: 13_400, value: 123_800 }] },
    ]);
  });

  it("gives nothing to draw with no ranges, or only zeros", () => {
    expect(leakBars([])).toEqual([]);
    expect(leakBars([{ key: "a", currency: "EUR", low_minor: 0, high_minor: 0 }])).toEqual([]);
  });
});
