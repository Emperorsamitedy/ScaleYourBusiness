// Idea 44, I-44.1 — the Eurostat snapshot behind "Compared with similar
// businesses". Run by hand, never at build time or in CI:
//
//   npm run benchmarks:fetch
//
// It writes specs/benchmarks-eurostat-v1.json, which the app reads and
// nothing else: the app makes no network call for a benchmark.
//
// Two keyless Eurostat datasets, through the dissemination API
// (https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/…):
//   · sbs_sc_ovw   "Enterprise statistics by size class and NACE Rev. 2
//                  activity (from 2021 onwards)". One request per country
//                  (the 27 EU members and the EU27_2020 aggregate), each
//                  naming every NACE code below and the five indicators,
//                  all years from 2021. Each cell keeps its latest year with
//                  a value; a confidential or unpublished cell is recorded
//                  as missing, never zero.
//   · ert_bil_eur_a  annual euro reference rates (statinfo AVG, unit NAC:
//                  national currency per euro), so a non-euro business's
//                  figures are compared in its own currency (rule 1).
//
// Manners: one request at a time, 1.5 s apart, at most 3 attempts each
// and 40 requests in all; a 413 ("treated asynchronously") waits and tries
// again within the same cap. Eurostat's reuse terms: free reuse with the
// source acknowledged, modifications stated, and a disclaimer that
// Eurostat isn't responsible; all three are written into the file.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonStat, Latest } from "../lib/benchmarks/jsonstat";
import { flagLabels, latest, observations } from "../lib/benchmarks/jsonstat";

const API = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const DATASET = "sbs_sc_ovw";
const FX_DATASET = "ert_bil_eur_a";
const SINCE = 2021;
const OUT = join(process.cwd(), "specs", "benchmarks-eurostat-v1.json");

/** The 27 EU members in Eurostat's codes (Greece is EL), then the EU aggregate. */
const GEOS = [
  "BE", "BG", "CZ", "DK", "DE", "EE", "IE", "EL", "ES", "FR", "HR", "IT", "CY", "LV",
  "LT", "LU", "HU", "MT", "NL", "AT", "PL", "PT", "RO", "SI", "SK", "FI", "SE",
  "EU27_2020",
] as const; // prettier-ignore

/**
 * Every NACE code specs/benchmark-map-v1.json names, as a business type's
 * code or its parent. benchmarks.test.ts holds the two lists together.
 */
export const NACE_CODES = [
  "C", "C10", "F", "F43", "G", "G45", "G452", "G46", "G47", "G479", "H", "H49",
  "I", "I55", "I56", "J", "J58", "J582", "J62", "L", "L68", "M", "M70", "M702",
  "M73", "M731", "M74", "N81", "N812", "P85", "P855", "Q", "Q86", "Q88", "Q889",
  "R93", "R931", "S96",
] as const; // prettier-ignore

/** What is read per cell. PUR_MEUR and NETTUR_MEUR only feed the purchases share. */
const INDICATORS = [
  "GOR_PC",
  "NETTUR_EMP_TEUR",
  "AVG_EXPN_SAL_BEN_TEUR",
  "PUR_MEUR",
  "NETTUR_MEUR",
];

/** Non-euro currencies an EU business may report in, plus a few common others. */
const FX_CURRENCIES = ["BGN", "CZK", "DKK", "HUF", "PLN", "RON", "SEK", "GBP", "USD", "CHF", "NOK"];

const DELAY_MS = 1_500;
const MAX_ATTEMPTS = 3;
const MAX_REQUESTS = 40;
const TIMEOUT_MS = 90_000;

let requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function url(dataset: string, params: [string, string][]): string {
  const all: [string, string][] = [["format", "JSON"], ["lang", "EN"], ...params];
  const q = all.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${API}/${dataset}?${q}`;
}

async function get(u: string): Promise<JsonStat> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (requests >= MAX_REQUESTS) throw new Error(`request cap of ${MAX_REQUESTS} reached`);
    requests++;
    await sleep(DELAY_MS);
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 413) {
        console.log(`  413, treated asynchronously; waiting (attempt ${attempt})`);
        await sleep(20_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as JsonStat;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      console.log(`  attempt ${attempt} failed: ${(e as Error).message}`);
      await sleep(5_000 * attempt);
    }
  }
  throw new Error(`no answer after ${MAX_ATTEMPTS} attempts: ${u}`);
}

type Value = Latest | { value: number; year: number; derived_from: string[] };

interface Cell {
  geo: string;
  nace: string;
  size: string;
  values: Record<string, Value>;
}

async function main(): Promise<void> {
  const retrieved = new Date().toISOString().slice(0, 10);
  const cells: Cell[] = [];
  const flags: Record<string, string> = {};
  const geoNames: Record<string, string> = {};
  const naceNames: Record<string, string> = {};
  const sizeNames: Record<string, string> = {};
  const indicatorNames: Record<string, string> = {};
  let updated = "";
  let label = "";
  const coverage: string[] = [];

  for (const geo of GEOS) {
    const u = url(DATASET, [
      ["geo", geo],
      ...NACE_CODES.map((n): [string, string] => ["nace_r2", n]),
      ...INDICATORS.map((i): [string, string] => ["indic_sbs", i]),
      ["sinceTimePeriod", String(SINCE)],
    ]);
    console.log(`${DATASET} ${geo}`);
    const d = await get(u);
    updated = d.updated ?? updated;
    label = d.label ?? label;
    Object.assign(flags, flagLabels(d));
    Object.assign(geoNames, d.dimension.geo?.category.label ?? {});
    Object.assign(naceNames, d.dimension.nace_r2?.category.label ?? {});
    Object.assign(sizeNames, d.dimension.size_emp?.category.label ?? {});
    Object.assign(indicatorNames, d.dimension.indic_sbs?.category.label ?? {});

    // nace → size → indicator → year → observation
    const tree = new Map<
      string,
      Map<string, Map<string, Map<number, { value: number | null; flag: string | null }>>>
    >();
    for (const o of observations(d)) {
      const { nace_r2: nace, size_emp: size, indic_sbs: ind, time } = o.codes;
      if (!nace || !size || !ind || !time) continue;
      const bySize = tree.get(nace) ?? new Map();
      tree.set(nace, bySize);
      const byInd = bySize.get(size) ?? new Map();
      bySize.set(size, byInd);
      const byYear = byInd.get(ind) ?? new Map();
      byInd.set(ind, byYear);
      byYear.set(Number(time), { value: o.value, flag: o.flag });
    }

    let kept = 0;
    let secret = 0;
    let latestYear = 0;
    for (const nace of NACE_CODES) {
      for (const [size, byInd] of tree.get(nace) ?? new Map()) {
        const series = (ind: string) =>
          [...(byInd.get(ind) ?? new Map()).entries()].map(([year, o]) => ({ year, ...o }));
        const values: Record<string, Value> = {};
        for (const ind of ["GOR_PC", "NETTUR_EMP_TEUR", "AVG_EXPN_SAL_BEN_TEUR"]) {
          values[ind] = latest(series(ind));
        }
        // Purchases as a share of net turnover: both figures from one year.
        const pur = new Map(series("PUR_MEUR").map((o) => [o.year, o]));
        const pairs = series("NETTUR_MEUR").map((t) => {
          const p = pur.get(t.year);
          const both = p && p.value !== null && t.value !== null && t.value > 0;
          return {
            year: t.year,
            value: both ? Math.round((p.value! / t.value!) * 10_000) / 100 : null,
            flag: both ? null : (p?.flag ?? t.flag),
          };
        });
        const share = latest(pairs);
        values.PUR_SHARE_PC =
          "value" in share
            ? { value: share.value, year: share.year, derived_from: ["PUR_MEUR", "NETTUR_MEUR"] }
            : share;
        // A figure Eurostat never published for the cell is left out (the
        // file's "absent" line says so); a confidential one is kept, named.
        for (const [k, v] of Object.entries(values)) {
          if ("missing" in v && v.missing === "not_published") delete values[k];
        }
        const any = Object.values(values);
        if (any.length === 0) continue;
        cells.push({ geo, nace, size, values });
        kept++;
        for (const v of any) {
          if ("missing" in v && v.missing === "confidential") secret++;
          if ("year" in v && "value" in v) latestYear = Math.max(latestYear, v.year);
        }
      }
    }
    coverage.push(
      `${geo}: ${kept} cells, ${secret} confidential figures, latest ${latestYear || "—"}`,
    );
  }

  console.log(`${FX_DATASET}`);
  const fx = await get(
    url(FX_DATASET, [
      ["statinfo", "AVG"],
      ["unit", "NAC"],
      ...FX_CURRENCIES.map((c): [string, string] => ["currency", c]),
      ["sinceTimePeriod", String(SINCE)],
    ]),
  );
  const rates: Record<string, Record<string, number>> = {};
  for (const o of observations(fx)) {
    const { currency, time } = o.codes;
    if (!currency || !time || o.value === null) continue;
    (rates[currency] ??= {})[time] = o.value;
  }

  const sbsUpdated = updated.slice(0, 10);
  const head = {
    version: "1",
    source: {
      publisher: "Eurostat",
      dataset: DATASET,
      label,
      doi: "https://doi.org/10.2908/SBS_SC_OVW",
      updated: sbsUpdated,
      retrieved,
      url_pattern: `${API}/${DATASET}?format=JSON&lang=EN&geo={geo}&nace_r2={nace}…&indic_sbs={indicator}…&sinceTimePeriod=${SINCE}`,
      licence:
        "Eurostat's reuse policy: free reuse, commercial or not, with the source acknowledged (editorial content under CC BY 4.0).",
      attribution: `Source: Eurostat, ${DATASET} (https://doi.org/10.2908/SBS_SC_OVW), retrieved ${retrieved}.`,
      modified:
        "SYB keeps each cell's latest year with a value, works out purchases as a share of net turnover, and converts euro figures to the business's own currency at Eurostat's annual average rate. Eurostat is not responsible for these uses of its data.",
    },
    indicators: indicatorNames,
    flags,
    geos: geoNames,
    nace: Object.fromEntries(NACE_CODES.map((n) => [n, naceNames[n] ?? n])),
    sizes: sizeNames,
    fx: {
      dataset: FX_DATASET,
      label: fx.label ?? "",
      updated: (fx.updated ?? "").slice(0, 10),
      statinfo: "AVG",
      unit: "NAC",
      meaning: "units of the currency per euro, the year's average",
      rates,
    },
    absent:
      "A figure missing from a cell was not published by Eurostat for that cell in any year since 2021. It is missing, never zero.",
    coverage,
  };

  // One cell per line: the file stays reviewable in a diff, and specs/ is
  // outside prettier (.prettierignore), so this layout is kept as written.
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const body = cells.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  writeFileSync(OUT, `${headText},\n  "cells": [\n${body}\n  ]\n}\n`);
  console.log(`\n${coverage.join("\n")}`);
  console.log(`\nwrote ${cells.length} cells to ${OUT} in ${requests} requests`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
