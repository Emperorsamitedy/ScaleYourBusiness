// P0-90 — measured API cost per intake vs the €1.31 estimate.
//
// Reads var/harness-report.json (written by npm run harness) and reports
// the real distribution: per-profile cost, per-turn cost, cache hit rate,
// and how the median compares to the plan's estimate. The estimate is a
// claim; this is the measurement.
// Usage: npx tsx scripts/cost-report.ts

import { readFileSync } from "node:fs";

/** The build plan's per-intake estimate (interviewer + parser only). */
const ESTIMATE_EUR = 1.31;

interface CallRecord {
  cost_eur: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
}

interface ProfileResult {
  persona: string;
  turns: unknown[];
  calls: CallRecord[];
}

interface Report {
  generated_at: string;
  crashed?: string[];
  results: ProfileResult[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function eur(n: number): string {
  return `€${n.toFixed(3)}`;
}

function main(): void {
  let report: Report;
  try {
    report = JSON.parse(readFileSync("var/harness-report.json", "utf8")) as Report;
  } catch {
    console.error("no var/harness-report.json — run `npm run harness` first");
    process.exit(1);
  }

  const rows = report.results.map((r) => {
    const cost = r.calls.reduce((n, c) => n + c.cost_eur, 0);
    const cached = r.calls.reduce((n, c) => n + c.cache_read_input_tokens, 0);
    const uncached = r.calls.reduce(
      (n, c) => n + c.input_tokens + c.cache_creation_input_tokens,
      0,
    );
    return {
      persona: r.persona,
      turns: r.turns.length,
      cost,
      per_turn: r.turns.length > 0 ? cost / r.turns.length : 0,
      cache_rate: cached + uncached > 0 ? cached / (cached + uncached) : 0,
    };
  });

  if (rows.length === 0) {
    console.error("report contains no completed profiles");
    process.exit(1);
  }

  console.log(`measured from ${rows.length} synthetic intakes · ${report.generated_at}`);
  if (report.crashed && report.crashed.length > 0) {
    console.log(`(${report.crashed.length} aborted, excluded from the measurement)`);
  }
  console.log("\npersona                     turns    cost   per-turn   cache");
  for (const r of [...rows].sort((a, b) => b.cost - a.cost)) {
    console.log(
      `${r.persona.padEnd(26)} ${String(r.turns).padStart(5)}  ${eur(r.cost).padStart(7)}   ${eur(
        r.per_turn,
      ).padStart(7)}  ${(r.cache_rate * 100).toFixed(0).padStart(4)}%`,
    );
  }

  const costs = rows.map((r) => r.cost);
  const med = median(costs);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const worst = Math.max(...costs);
  const best = Math.min(...costs);

  console.log("\n==== per intake ====");
  console.log(`median   : ${eur(med)}`);
  console.log(`mean     : ${eur(mean)}`);
  console.log(`range    : ${eur(best)} … ${eur(worst)}`);
  console.log(`estimate : ${eur(ESTIMATE_EUR)}`);

  const delta = ((med - ESTIMATE_EUR) / ESTIMATE_EUR) * 100;
  const verdict =
    med <= ESTIMATE_EUR
      ? `UNDER the estimate by ${Math.abs(delta).toFixed(0)}%`
      : `OVER the estimate by ${delta.toFixed(0)}%`;
  console.log(`verdict  : median is ${verdict}`);

  // A synthetic persona answers every applicable question, including the
  // deep tier — a real owner stops earlier, so this is an upper bound.
  console.log(
    "\nnote: personas answer every applicable question to completion;" +
      "\na real intake stops sooner, so treat this as an upper bound.",
  );
  process.exit(0);
}

main();
