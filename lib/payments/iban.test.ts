// P6-05 — an IBAN is accepted only when its country is known, its length
// is that country's and the mod-97 check gives 1; a BIC is 8 or 11; and an
// IBAN is never shown whole outside the row that holds it.

import { describe, expect, it } from "vitest";
import {
  IBAN_LENGTHS,
  SEPA_COUNTRIES,
  checkBic,
  checkIban,
  groupIban,
  ibanMod97,
  maskIban,
  normalizeIban,
} from "./iban";

const GOOD = [
  "DE89370400440532013000",
  "GB82WEST12345698765432",
  "NL91ABNA0417164300",
  "FR1420041010050500013M02606",
  "BE68539007547034",
  "AT611904300234573201",
  "CH9300762011623852957",
  "ES9121000418450200051332",
  "IT60X0542811101000000123456",
  "NO9386011117947",
  "AE070331234567890123456",
];

describe("checkIban — country, length, mod-97 (passing)", () => {
  it("accepts real IBANs, typed with spaces and in lower case too", () => {
    for (const iban of GOOD) expect(checkIban(iban), iban).toMatchObject({ ok: true, iban });
    expect(checkIban("de89 3704 0044 0532 0130 00")).toEqual({
      ok: true,
      iban: "DE89370400440532013000",
      country: "DE",
    });
    expect(normalizeIban(" gb82-west-1234 5698 7654 32 ")).toBe("GB82WEST12345698765432");
  });

  it("mod-97 of a valid IBAN is 1, computed piece by piece (no big numbers)", () => {
    for (const iban of GOOD) expect(ibanMod97(iban), iban).toBe(1);
  });

  it("knows each SEPA country's length", () => {
    for (const c of SEPA_COUNTRIES) expect(IBAN_LENGTHS[c], c).toBeGreaterThan(14);
  });
});

describe("checkIban — a bad IBAN is refused with its reason (failing)", () => {
  it("a mistyped digit fails the check digits", () => {
    expect(checkIban("DE89370400440532013001")).toEqual({ ok: false, reason: "checksum" });
    // Two digits swapped: the classic typo mod-97 exists to catch.
    expect(checkIban("DE89370400440532010300")).toEqual({ ok: false, reason: "checksum" });
  });

  it("check digits outside 02..98 are refused, though mod-97 alone passes them", () => {
    // A computed check is 98 − (BBAN·country·00 mod 97): never 00, 01 or 99.
    // But 00 ≡ 97, 01 ≡ 98 and 99 ≡ 02 (mod 97), so a typo of the one for
    // the other passes mod-97: only the range catches it.
    const checkOf = (bban: string) => 98 - ibanMod97(`DE00${bban}`);
    const twin: Record<number, string> = { 2: "99", 97: "00", 98: "01" };
    const found = new Map<number, string>();
    for (let n = 0; found.size < 3 && n < 100_000; n++) {
      const bban = String(370400440532000000 + n).padStart(18, "0");
      const c = checkOf(bban);
      if (twin[c] && !found.has(c)) found.set(c, bban);
    }
    expect(found.size).toBe(3);
    for (const [c, bban] of found) {
      const real = `DE${String(c).padStart(2, "0")}${bban}`;
      const typo = `DE${twin[c]}${bban}`;
      expect(checkIban(real), real).toMatchObject({ ok: true });
      expect(ibanMod97(typo), typo).toBe(1);
      expect(checkIban(typo), typo).toEqual({ ok: false, reason: "checksum" });
    }
  });

  it("the wrong length for its country", () => {
    expect(checkIban("DE8937040044053201300")).toEqual({ ok: false, reason: "length" });
    expect(checkIban("NL91ABNA04171643000")).toEqual({ ok: false, reason: "length" });
  });

  it("an unknown country, a wrong shape, nothing at all", () => {
    expect(checkIban("XX89370400440532013000")).toEqual({ ok: false, reason: "country" });
    expect(checkIban("1234567890")).toEqual({ ok: false, reason: "format" });
    expect(checkIban("DE89 3704 0044 0532 0130 0!")).toEqual({ ok: false, reason: "format" });
    expect(checkIban("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("checkBic", () => {
  it("8 or 11 letters and digits, normalised", () => {
    expect(checkBic("cobadeffxxx")).toBe("COBADEFFXXX");
    expect(checkBic("DEUTDEFF")).toBe("DEUTDEFF");
    expect(checkBic("DEUTDEF")).toBeNull();
    expect(checkBic("DEUTDEFF5")).toBeNull();
    expect(checkBic("1EUTDEFF")).toBeNull();
  });
});

describe("maskIban — an IBAN is never shown whole outside its row", () => {
  it("keeps the country and the last four only, at a fixed width", () => {
    expect(maskIban("DE89370400440532013000")).toBe("DE•• •••• 3000");
    expect(maskIban("NO9386011117947")).toBe("NO•• •••• 7947");
    for (const iban of GOOD) {
      const m = maskIban(iban);
      expect(m).not.toContain(iban.slice(2, -4));
      expect(m.replace(/[^A-Z0-9]/g, "").length).toBe(6);
    }
    expect(maskIban(null)).toBe("");
  });

  it("groups for reading the way a bank's form does", () => {
    expect(groupIban("DE89370400440532013000")).toBe("DE89 3704 0044 0532 0130 00");
  });
});
