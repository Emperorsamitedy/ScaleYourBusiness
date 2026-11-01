// L-2: figures typed the person's way are read exactly, and an ambiguous
// one is never guessed (lib/intake/amount-input.ts).

import { describe, expect, it } from "vitest";
import { num } from "../../components/sheet/num";
import { decimalsOf, readTypedAmount } from "./amount-input";

describe("readTypedAmount — every unambiguous convention, in any language", () => {
  it("reads German, French (spaces of every kind), Hungarian and English writing exactly", () => {
    expect(readTypedAmount("1.234,56")).toEqual({ kind: "value", decimal: "1234.56" });
    expect(readTypedAmount("1 234,56")).toEqual({ kind: "value", decimal: "1234.56" });
    expect(readTypedAmount("1 234,56")).toEqual({ kind: "value", decimal: "1234.56" });
    expect(readTypedAmount("1 234,56")).toEqual({ kind: "value", decimal: "1234.56" });
    expect(readTypedAmount("1,234.56")).toEqual({ kind: "value", decimal: "1234.56" });
    expect(readTypedAmount("12,5")).toEqual({ kind: "value", decimal: "12.5" });
    expect(readTypedAmount("12.50")).toEqual({ kind: "value", decimal: "12.5" });
    expect(readTypedAmount("1.234.567")).toEqual({ kind: "value", decimal: "1234567" });
    expect(readTypedAmount("€ 1.234,50")).toEqual({ kind: "value", decimal: "1234.5" });
    expect(readTypedAmount("4 090 Ft")).toEqual({ kind: "value", decimal: "4090" });
    expect(readTypedAmount("-3")).toEqual({ kind: "value", decimal: "-3" });
    expect(readTypedAmount("0")).toEqual({ kind: "value", decimal: "0" });
  });

  it("asks rather than guesses when a lone mark sits before three digits", () => {
    expect(readTypedAmount("1.200")).toEqual({
      kind: "ambiguous",
      grouped: "1200",
      decimal: "1.2",
    });
    expect(readTypedAmount("12,000")).toEqual({
      kind: "ambiguous",
      grouped: "12000",
      decimal: "12",
    });
  });

  it("says when a figure isn't one, and when nothing is typed", () => {
    expect(readTypedAmount("")).toEqual({ kind: "empty" });
    expect(readTypedAmount("   ")).toEqual({ kind: "empty" });
    expect(readTypedAmount("about a thousand")).toEqual({ kind: "unreadable" });
    expect(readTypedAmount("1,23,4")).toEqual({ kind: "unreadable" });
  });

  it("offers the two readings in the person's own writing", () => {
    const r = readTypedAmount("1.200");
    if (r.kind !== "ambiguous") throw new Error("expected ambiguous");
    const show = (d: string) => num(Number(d), decimalsOf(d), "de-DE");
    expect([show(r.grouped), show(r.decimal)]).toEqual(["1.200", "1,2"]);
    const fr = (d: string) => num(Number(d), decimalsOf(d), "fr-FR");
    expect(fr(r.grouped)).toBe("1 200");
  });
});
