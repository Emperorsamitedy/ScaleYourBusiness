// L-4b: the comparison's sentences are "benchmarksWords" messages. English
// is held to the map's own words (every group, cover note, size class and
// unmapped type), and a fake translator shows every sentence goes through
// the catalogue with its figures in the reader's locale.

import { describe, expect, it } from "vitest";
import type { Tr } from "../i18n/tr";
import type { BenchInputs, BenchLine, ComparedLine } from "./compare";
import { CAVEAT, EVERY_SIZE_NOTE, compareWithSimilar, countryWords } from "./compare";
import {
  BENCHMARK_MAP,
  coversWords,
  groupWords,
  mappedNaceCodes,
  parentGroup,
  sizeWords,
  unmappedWords,
} from "./map";
import type { BenchCell, Snapshot } from "./snapshot";
import { SNAPSHOT } from "./snapshot";

const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const GERMAN = { tr: fake, locale: "de-DE" as const };

const fact = { basis: "STATED" as const, source: "as you told me" };
const eur = (major: number) => ({
  amount_minor: major * 100,
  currency: "EUR",
  on: "2026-10-01",
  ...fact,
});
const inputs: BenchInputs = {
  as_of: "2026-10-29",
  business_type: { code: "restaurant" },
  country: { raw: "Ireland", iso: "IE" },
  team_size: { value: 3, ...fact },
  size_band: null,
  revenue: eur(20_000),
  orders_month: null,
  gross_margin: { value: 70, ...fact },
  offers: [],
  costs: [
    {
      key: "costs.rent",
      label: "rent",
      category: "rent",
      list: "fixed",
      amount: eur(2_000),
      cadence: "monthly",
    },
  ],
  staff: [{ key: "operations.a", engagement: "employee", cost: eur(2_500) }],
};
const CELLS: BenchCell[] = [
  {
    geo: "IE",
    nace: "I56",
    size: "TOTAL",
    values: {
      GOR_PC: { value: 25, year: 2024 },
      AVG_EXPN_SAL_BEN_TEUR: { value: 30, year: 2024 },
    },
  },
  {
    geo: "IE",
    nace: "I56",
    size: "0-9",
    values: { NETTUR_EMP_TEUR: { value: 50, year: 2024, flag: "e" } },
  },
];
const snap: Snapshot = { ...SNAPSHOT, cells: CELLS };
const compared = (l: BenchLine | undefined): ComparedLine => {
  if (!l || l.status !== "compared") throw new Error(`not compared: ${JSON.stringify(l)}`);
  return l;
};

describe("English is the map's own words", () => {
  it("names every group, cover note and unmapped type exactly as the map does", () => {
    for (const [type, e] of Object.entries(BENCHMARK_MAP.business_types)) {
      if (e.nace === null) {
        expect(unmappedWords(type, "fallback"), type).toBe(e.why);
        continue;
      }
      expect(groupWords(e.nace, "fallback"), type).toBe(e.group);
      expect(coversWords(e.nace, "fallback"), type).toBe(e.covers);
    }
    for (const code of mappedNaceCodes()) {
      if (Object.hasOwn(BENCHMARK_MAP.parent_groups, code))
        expect(groupWords(code, "fallback"), code).toBe(parentGroup(code));
    }
    expect(groupWords("Z99", "the map's own")).toBe("the map's own");
  });
  it("words every size class as the map does, and Eurostat's flags as the snapshot does", () => {
    for (const c of BENCHMARK_MAP.size_classes) expect(sizeWords(c.code)).toBe(`with ${c.words}`);
    expect(sizeWords("TOTAL")).toBe(BENCHMARK_MAP.all_sizes.words);
    const r = compareWithSimilar(inputs, snap);
    if (r.status !== "ready") throw new Error(r.status);
    const t = compared(r.lines.find((l) => l.key === "turnover_per_person"));
    expect(t.cell.flag).toBe(SNAPSHOT.flags.e);
    expect(r.caveat).toBe(CAVEAT);
    expect(CAVEAT).toBe(
      "These are totals across every business in the group, not a typical business.",
    );
    expect(EVERY_SIZE_NOTE.startsWith(" Eurostat works that out")).toBe(true);
    expect(t.formula).toBe("€20,000 a month × 12 ÷ 3 people = €80,000");
  });
});

describe("another language goes through the translator", () => {
  const r = compareWithSimilar(inputs, snap, GERMAN, GERMAN);
  if (r.status !== "ready") throw new Error(r.status);

  it("words the head, its country through Intl, and every line's sentences", () => {
    expect(r.head.group).toBe("[group.I56]");
    expect(r.head.covers).toBe('[covers.I56 {"code":"I56"}]');
    expect(r.head.country).toBe("Irland");
    expect(r.caveat).toBe("[caveat]");
    for (const l of r.lines) {
      // "[title.<line>]" from benchmarksWords, or "[title]" from the purchases line's own namespace.
      expect(l.title).toMatch(/^\[title[.\]]/);
      expect(l.gap_note).toMatch(/^\[gapNote[.\]]/);
    }
  });
  it("formats the figures in German, the business's currency unconverted", () => {
    const t = compared(r.lines.find((l) => l.key === "turnover_per_person"));
    expect(t.own_words).toBe("80.000 €");
    expect(t.formula).toContain('"amount":"20.000 €"');
    expect(t.formula.startsWith("[formula.turnover")).toBe(true);
    expect(t.cell.words).toContain('"country":"Irland"');
    expect(t.cell.flag).toBe("[flag.e]");
    const m = compared(r.lines.find((l) => l.key === "operating_margin"));
    expect(m.own_words).toMatch(/^\d+,\d\s%$/);
  });
  it("leaves no English sentence behind", () => {
    const text = JSON.stringify(r.lines.map((l) => ({ ...l, cell: undefined, derived_from: [] })));
    expect(text).not.toMatch(
      /Revenue a month|a month ×| people|Operating margin|about the same:| points |Eurostat publishes/,
    );
  });
  it("names a country in the reader's language, Greece by its ISO code", () => {
    expect(countryWords(SNAPSHOT, "EL", GERMAN)).toBe("Griechenland");
    expect(countryWords(SNAPSHOT, "EL")).toBe(SNAPSHOT.geos.EL);
  });
});
