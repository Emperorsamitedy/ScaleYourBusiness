#!/usr/bin/env node
/* global process, console */
// Recompute a quarterly guarantee evaluation from the ledger alone — the v1
// build spec §8.6: "reproducible from the ledger by an auditor with no
// application access."
//
// Standalone on purpose: Node's built-ins only, nothing imported from the
// application. Give it an evaluation export (lib/billing/guarantee-run.ts,
// exportForAudit) — the ledger entries it read, with their chain hashes —
// and it checks the inputs' hash and recomputes the outcome:
//
//   node scripts/verify-guarantee.mjs evaluation.json
//
// The rules, as §8.4 states them:
//   · Autonomous tier only
//   · only plans graded A, B or C count; verified gains and losses both
//   · shadow plans don't count; entries in another currency are left out,
//     never converted
//   · fewer than 8 closed plans: rolled forward, no payout
//   · met when verified × 10 000 ≥ fee × 30 000 (3×), in integers

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RULES = Object.freeze({
  tier: "autonomous",
  threshold_bp: 30000,
  min_closed_plans: 8,
  grades: ["A", "B", "C"],
});

/** The hash of the inputs, exactly as the application wrote it. */
export function inputsHash(inputs) {
  const canonical = {
    tier: inputs.tier,
    fee: { amount_minor: inputs.fee.amount_minor, currency: inputs.fee.currency },
    entries: inputs.entries.map((e) => ({
      id: e.id,
      plan_id: e.plan_id,
      seq: e.seq,
      verdict: e.verdict,
      net_minor: e.net_minor,
      currency: e.currency,
      grade: e.grade,
      shadow: e.shadow,
      entry_hash: e.entry_hash,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The outcome, from the inputs alone. */
export function recompute(inputs) {
  if (inputs.tier !== RULES.tier) return { applies: false, reason: "not_autonomous" };
  const currency = inputs.fee.currency;
  const real = inputs.entries.filter((e) => !e.shadow);
  let verified = 0n;
  let other = 0;
  for (const e of real) {
    if (e.currency !== currency) {
      other += 1;
      continue;
    }
    if (e.verdict !== "verified_gain" && e.verdict !== "loss") continue;
    if (!RULES.grades.includes(e.grade) || e.net_minor === null) continue;
    verified += BigInt(e.net_minor);
  }
  const fee = BigInt(inputs.fee.amount_minor);
  const closed = real.length;
  let outcome;
  if (closed < RULES.min_closed_plans) outcome = "rolled_forward";
  else outcome = verified * 10000n >= fee * BigInt(RULES.threshold_bp) ? "met" : "credit";
  return {
    applies: true,
    outcome,
    closed_plans: closed,
    verified_minor: Number(verified),
    fee_minor: Number(fee),
    currency,
    other_currency_entries: other,
  };
}

/** Check an export: the hash it claims, and the outcome it claims. */
export function verify(exported) {
  const hash = inputsHash(exported.inputs);
  const mine = recompute(exported.inputs);
  const theirs = exported.result;
  const same =
    mine.applies === theirs.applies &&
    (!mine.applies ||
      (mine.outcome === theirs.outcome &&
        mine.closed_plans === theirs.closed_plans &&
        mine.verified_minor === theirs.verified.amount_minor &&
        mine.fee_minor === theirs.fee.amount_minor));
  return { hash_ok: hash === exported.inputs_hash, outcome_ok: same, recomputed: mine };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/verify-guarantee.mjs <evaluation.json>");
    process.exit(2);
  }
  const report = verify(JSON.parse(readFileSync(file, "utf8")));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.hash_ok && report.outcome_ok ? 0 : 1);
}
