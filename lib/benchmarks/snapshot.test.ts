// I-44.1: the committed Eurostat snapshot holds its shape, and nothing in it
// is fabricated — every figure sits in a named cell (dataset, geo, NACE
// code, size class) with its year; a missing figure is missing, never zero.

import { describe, expect, it } from "vitest";
import type { JsonStat } from "./jsonstat";
import { flagLabels, isConfidential, latest, observations } from "./jsonstat";
import type { Snapshot } from "./snapshot";
import { METRICS, SNAPSHOT, cellIndex, eurRate, isValue } from "./snapshot";

const EU27 = [
  "BE", "BG", "CZ", "DK", "DE", "EE", "IE", "EL", "ES", "FR", "HR", "IT", "CY", "LV",
  "LT", "LU", "HU", "MT", "NL", "AT", "PL", "PT", "RO", "SI", "SK", "FI", "SE",
]; // prettier-ignore

/** Pure: every way a snapshot can be wrong, as sentences. Empty means sound. */
function problems(s: Snapshot): string[] {
  const out: string[] = [];
  if (s.source.dataset !== "sbs_sc_ovw") out.push("dataset isn't sbs_sc_ovw");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.source.updated)) out.push("no updated date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.source.retrieved)) out.push("no retrieval date");
  if (!s.source.attribution.includes("Eurostat")) out.push("no attribution");
  if (!s.source.modified.includes("not responsible")) out.push("no disclaimer");
  const seen = new Set<string>();
  for (const c of s.cells) {
    const where = `${c.geo}/${c.nace}/${c.size}`;
    if (!(c.geo in s.geos)) out.push(`${where}: geo not named`);
    if (!(c.nace in s.nace)) out.push(`${where}: NACE code not named`);
    if (!(c.size in s.sizes)) out.push(`${where}: size class not named`);
    if (seen.has(where)) out.push(`${where}: twice`);
    seen.add(where);
    const entries = Object.entries(c.values);
    if (entries.length === 0) out.push(`${where}: an empty cell`);
    for (const [m, f] of entries) {
      if (!(METRICS as readonly string[]).includes(m)) out.push(`${where}: unknown metric ${m}`);
      if (!f || !Number.isInteger(f.year) || f.year < 2021) out.push(`${where} ${m}: no year`);
      if (f && "missing" in f && f.missing !== "confidential")
        out.push(`${where} ${m}: bad missing`);
      if (f && "value" in f && !Number.isFinite(f.value)) out.push(`${where} ${m}: not a number`);
      if (m === "PUR_SHARE_PC" && isValue(f) && f.derived_from?.join() !== "PUR_MEUR,NETTUR_MEUR")
        out.push(`${where} ${m}: a worked-out figure without what it came from`);
    }
  }
  return out;
}

describe("the committed snapshot (I-44.1)", () => {
  it("is sound: every figure in a named cell with its year", () => {
    expect(problems(SNAPSHOT)).toEqual([]);
  });

  it("names its source, dated", () => {
    expect(SNAPSHOT.source).toMatchObject({
      dataset: "sbs_sc_ovw",
      doi: "https://doi.org/10.2908/SBS_SC_OVW",
      updated: "2026-09-30",
      retrieved: "2026-10-29",
    });
    expect(SNAPSHOT.fx.dataset).toBe("ert_bil_eur_a");
  });

  it("covers the 27 members and the EU aggregate", () => {
    const geos = new Set(SNAPSHOT.cells.map((c) => c.geo));
    for (const g of [...EU27, "EU27_2020"]) expect(geos.has(g), g).toBe(true);
    expect(geos.size).toBe(28);
  });

  it("holds no zero standing in for a missing figure", () => {
    // A zero rate or a zero turnover per person would be a missing cell read wrong.
    for (const c of SNAPSHOT.cells) {
      for (const m of ["NETTUR_EMP_TEUR", "AVG_EXPN_SAL_BEN_TEUR"] as const) {
        const f = c.values[m];
        if (isValue(f)) expect(f.value, `${c.geo}/${c.nace}/${c.size}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps confidential figures as missing, by name", () => {
    const secret = SNAPSHOT.cells.flatMap((c) =>
      Object.values(c.values).filter((f) => f && "missing" in f),
    );
    expect(secret.length).toBeGreaterThan(0);
    expect(secret.every((f) => f && "missing" in f && f.missing === "confidential")).toBe(true);
  });

  it("reads one cell Eurostat published, as published", () => {
    // Checked by hand against the live API on 2026-10-29.
    const hu = cellIndex(SNAPSHOT)("HU", "I56", "TOTAL");
    expect(hu?.values.GOR_PC).toEqual({ value: 12.04, year: 2024 });
    expect(hu?.values.NETTUR_EMP_TEUR).toEqual({ value: 48.23, year: 2024 });
    expect(cellIndex(SNAPSHOT)("HU", "I56", "2-9")).toBeNull();
  });

  it("has the forint's average rate and none it wasn't given", () => {
    expect(eurRate(SNAPSHOT, "HUF", 2023)).toBe(381.85);
    expect(eurRate(SNAPSHOT, "EUR", 2024)).toBe(1);
    expect(eurRate(SNAPSHOT, "XYZ", 2024)).toBeNull();
    expect(eurRate(SNAPSHOT, "HUF", 1999)).toBeNull();
  });
});

describe("the soundness check itself", () => {
  const base: Snapshot = {
    ...SNAPSHOT,
    cells: [
      { geo: "HU", nace: "I56", size: "TOTAL", values: { GOR_PC: { value: 1, year: 2024 } } },
    ],
  };
  it("passes a sound cell", () => {
    expect(problems(base)).toEqual([]);
  });
  it("fails a figure with no year, an unnamed cell, and a zero for a missing figure's sake", () => {
    const bad: Snapshot = {
      ...base,
      cells: [
        { geo: "XX", nace: "I56", size: "TOTAL", values: { GOR_PC: { value: 1, year: 2024 } } },
        {
          geo: "HU",
          nace: "I56",
          size: "0-9",
          values: { GOR_PC: { value: 1 } as unknown as { value: number; year: number } },
        },
        { geo: "HU", nace: "I56", size: "10-19", values: {} },
        {
          geo: "HU",
          nace: "I56",
          size: "20-49",
          values: { PUR_SHARE_PC: { value: 50, year: 2024 } },
        },
      ],
    };
    const p = problems(bad);
    expect(p).toContain("XX/I56/TOTAL: geo not named");
    expect(p).toContain("HU/I56/0-9 GOR_PC: no year");
    expect(p).toContain("HU/I56/10-19: an empty cell");
    expect(p).toContain("HU/I56/20-49 PUR_SHARE_PC: a worked-out figure without what it came from");
  });
});

describe("reading JSON-stat (lib/benchmarks/jsonstat.ts)", () => {
  // Two indicators × one NACE × two sizes × two years, row-major, the last
  // dimension fastest — the layout Eurostat's answers use.
  const d: JsonStat = {
    id: ["indic_sbs", "size_emp", "time"],
    size: [2, 2, 2],
    dimension: {
      indic_sbs: { category: { index: { GOR_PC: 0, NETTUR_EMP_TEUR: 1 } } },
      size_emp: { category: { index: { TOTAL: 0, "0-9": 1 } } },
      time: { category: { index: { "2023": 0, "2024": 1 } } },
    },
    value: { "0": 10.5, "1": 11.2, "4": 30, "5": 31, "6": 25 },
    status: { "3": "|C", "1": "e" },
    extension: { status: { label: { "|C": "|confidential", e: "estimated" } } },
  };

  it("decodes sparse positions, keeping flags and skipping empty ones", () => {
    const obs = observations(d);
    expect(obs).toHaveLength(6);
    expect(obs[0]).toEqual({
      codes: { indic_sbs: "GOR_PC", size_emp: "TOTAL", time: "2023" },
      value: 10.5,
      flag: null,
    });
    expect(
      obs.find(
        (o) =>
          o.codes.time === "2024" && o.codes.size_emp === "TOTAL" && o.codes.indic_sbs === "GOR_PC",
      )?.flag,
    ).toBe("e");
    // Position 3: GOR_PC, 0-9, 2024 — confidential, no value.
    expect(obs.find((o) => o.flag === "|C")).toEqual({
      codes: { indic_sbs: "GOR_PC", size_emp: "0-9", time: "2024" },
      value: null,
      flag: "|C",
    });
    // Position 2 (GOR_PC, 0-9, 2023) holds nothing at all: absent, not zero.
    expect(
      obs.some(
        (o) =>
          o.codes.size_emp === "0-9" && o.codes.time === "2023" && o.codes.indic_sbs === "GOR_PC",
      ),
    ).toBe(false);
  });

  it("names the flags", () => {
    expect(flagLabels(d)).toEqual({ "|C": "confidential", e: "estimated" });
    expect(isConfidential("|C")).toBe(true);
    expect(isConfidential("b|C")).toBe(true);
    expect(isConfidential("e")).toBe(false);
    expect(isConfidential(null)).toBe(false);
  });

  it("takes the latest year with a value, or says why there is none", () => {
    expect(
      latest([
        { year: 2023, value: 1, flag: null },
        { year: 2024, value: null, flag: "|C" },
      ]),
    ).toEqual({ value: 1, year: 2023 });
    expect(latest([{ year: 2024, value: 2, flag: "e" }])).toEqual({
      value: 2,
      year: 2024,
      flag: "e",
    });
    expect(latest([{ year: 2024, value: null, flag: "|C" }])).toEqual({
      missing: "confidential",
      year: 2024,
    });
    expect(latest([])).toEqual({ missing: "not_published" });
  });
});
