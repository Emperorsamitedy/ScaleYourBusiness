// I-01 (TASKS-IDEAS.md) — the Eurostat snapshot behind an idea's survival
// odds. Run by hand, never at build time or in CI:
//
//   npm run demography:fetch
//
// It writes specs/business-demography-v1.json, which the app reads and
// nothing else: the app makes no network call for a survival rate.
//
// One keyless Eurostat dataset, bd_9bd_sz_cl_r2, "Business demography by
// size class and NACE Rev. 2 activity (2004-2020)": its published survival
// rates 1, 3 and 5 (V97041, V97043, V97045 — enterprises born in t−n still
// active in t, over births in t−n). D92: the newer bd_size (from 2021)
// publishes only the 1-year rate so far, and the two tables differ in
// method, so all three rates come from this one table and each keeps its
// own year. Every size class together (TOTAL); a new business is small.
//
// The NACE codes are the benchmark map's own (codes and parents), so the
// two snapshots can't drift apart. Manners as fetch-benchmarks.ts: one
// request at a time, 1.5 s apart, at most 3 attempts each and 40 in all.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonStat, Latest } from "../lib/benchmarks/jsonstat";
import { flagLabels, latest, observations } from "../lib/benchmarks/jsonstat";
import { BENCHMARK_MAP, mappedNaceCodes } from "../lib/benchmarks/map";

const API = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const DATASET = "bd_9bd_sz_cl_r2";
const SINCE = 2014;
const OUT = join(process.cwd(), "specs", "business-demography-v1.json");
const RATES = { V97041: "y1", V97043: "y3", V97045: "y5" } as const;

const DELAY_MS = 1_500;
const MAX_ATTEMPTS = 3;
const MAX_REQUESTS = 80;
const TIMEOUT_MS = 90_000;

let requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface Cell {
  geo: string;
  nace: string;
  rates: Partial<Record<(typeof RATES)[keyof typeof RATES], Latest>>;
  /** Gap 6: the newer table's one-year rate (bd_size), kept apart — another method, never mixed in. */
  newer_y1?: Latest;
}

/** Gap 6: bd_size, "from 2021 onwards", publishes the one-year survival rate only so far. */
const NEWER = { dataset: "bd_size", indicator: "ENT_SRVLR_BRTH_PC", age: "Y1", since: 2021 };

async function main(): Promise<void> {
  const retrieved = new Date().toISOString().slice(0, 10);
  const naceCodes = mappedNaceCodes();
  const geos = BENCHMARK_MAP.countries.eu27;
  const cells: Cell[] = [];
  const flags: Record<string, string> = {};
  const naceNames: Record<string, string> = {};
  const geoNames: Record<string, string> = {};
  const coverage: string[] = [];
  let updated = "";
  let label = "";

  for (const geo of geos) {
    const q = [
      ["format", "JSON"],
      ["lang", "EN"],
      ["geo", geo],
      ["sizeclas", "TOTAL"],
      ...naceCodes.map((n) => ["nace_r2", n]),
      ...Object.keys(RATES).map((i) => ["indic_sb", i]),
      ["sinceTimePeriod", String(SINCE)],
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    console.log(`${DATASET} ${geo}`);
    const d = await get(`${API}/${DATASET}?${q}`);
    updated = d.updated ?? updated;
    label = d.label ?? label;
    Object.assign(flags, flagLabels(d));
    Object.assign(naceNames, d.dimension.nace_r2?.category.label ?? {});
    Object.assign(geoNames, d.dimension.geo?.category.label ?? {});

    const byNace = new Map<
      string,
      Map<string, { year: number; value: number | null; flag: string | null }[]>
    >();
    for (const o of observations(d)) {
      const { nace_r2: nace, indic_sb: ind, time } = o.codes;
      if (!nace || !ind || !time) continue;
      const m = byNace.get(nace) ?? new Map();
      byNace.set(nace, m);
      const list = m.get(ind) ?? [];
      m.set(ind, list);
      list.push({ year: Number(time), value: o.value, flag: o.flag });
    }
    let kept = 0;
    let latestYear = 0;
    for (const nace of naceCodes) {
      const m = byNace.get(nace);
      if (!m) continue;
      const rates: Cell["rates"] = {};
      for (const [ind, key] of Object.entries(RATES)) {
        const v = latest(m.get(ind) ?? []);
        if ("missing" in v && v.missing === "not_published") continue;
        rates[key] = v;
        if ("value" in v) latestYear = Math.max(latestYear, v.year);
      }
      if (Object.keys(rates).length === 0) continue;
      cells.push({ geo, nace, rates });
      kept++;
    }
    coverage.push(`${geo}: ${kept} cells, latest ${latestYear || "—"}`);
  }

  // Gap 6: the newer one-year rate, cell by cell, kept apart from the 2020 set.
  for (const geo of geos) {
    const q = [
      ["format", "JSON"],
      ["lang", "EN"],
      ["geo", geo],
      ["sizeclas", "TOTAL"],
      ["age", NEWER.age],
      ["indic_sbs", NEWER.indicator],
      ...naceCodes.map((n) => ["nace_r2", n]),
      ["sinceTimePeriod", String(NEWER.since)],
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    console.log(`${NEWER.dataset} ${geo}`);
    const d = await get(`${API}/${NEWER.dataset}?${q}`);
    Object.assign(flags, flagLabels(d));
    const byNace = new Map<string, { year: number; value: number | null; flag: string | null }[]>();
    for (const o of observations(d)) {
      const { nace_r2: nace, time } = o.codes;
      if (!nace || !time) continue;
      const list = byNace.get(nace) ?? [];
      byNace.set(nace, list);
      list.push({ year: Number(time), value: o.value, flag: o.flag });
    }
    for (const [nace, list] of byNace) {
      const v = latest(list);
      if (!("value" in v)) continue;
      const cell = cells.find((c) => c.geo === geo && c.nace === nace);
      if (cell) cell.newer_y1 = v;
      else cells.push({ geo, nace, rates: {}, newer_y1: v });
    }
  }

  const head = {
    version: "1",
    source: {
      publisher: "Eurostat",
      dataset: DATASET,
      label,
      doi: "https://doi.org/10.2908/BD_9BD_SZ_CL_R2",
      updated: updated.slice(0, 10),
      retrieved,
      licence:
        "Eurostat's reuse policy: free reuse, commercial or not, with the source acknowledged (editorial content under CC BY 4.0).",
      attribution: `Source: Eurostat, ${DATASET}, retrieved ${retrieved}.`,
      modified:
        "ScaleX keeps each cell's latest year with a value for each rate, for every size class together. Eurostat is not responsible for these uses of its data.",
    },
    rates: {
      y1: "V97041: enterprises born in t-1 still active in t, over births in t-1 (%)",
      y3: "V97043: enterprises born in t-3 still active in t, over births in t-3 (%)",
      y5: "V97045: enterprises born in t-5 still active in t, over births in t-5 (%)",
      newer_y1: `${NEWER.dataset} ${NEWER.indicator} age ${NEWER.age}: the newer table's one-year survival rate (%), a different method — shown apart, never mixed with y1`,
    },
    flags,
    geos: geoNames,
    nace: Object.fromEntries(naceCodes.map((n) => [n, naceNames[n] ?? n])),
    absent:
      "A rate missing from a cell was not published by Eurostat for it in any year since 2014. It is missing, never zero, and never filled from another country.",
    coverage,
  };
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
