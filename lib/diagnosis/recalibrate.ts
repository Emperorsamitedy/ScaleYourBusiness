// M-2: the recalibration run's comparison — pure, so it is unit-tested on
// fake model outputs. scripts/recalibrate-diagnosis.ts runs the diagnosis
// on each business's stored snapshot with both Opus models (and, with
// --sonnet, the interviewer's pick with both Sonnets) and hands the
// results here to be compared, printed and written up as markdown.
//
// Matching is deliberately simple and explainable: two findings are the
// same topic when they sit in the same area, or cite largely the same
// evidence, and their evidence and titles overlap enough. Pairs are taken
// best-first, each finding used once. A human reads the side-by-side; the
// matcher only lines the rows up.

import type { LlmCallRecord } from "../llm/cost-log";
import type { DiagnosisFinding, RejectedFinding, Severity } from "./findings";
import {
  DiagnosisRefusalError,
  parseDiagnosisText,
  SEVERITIES,
  sortFindings,
  threeSentences,
  validateFindings,
} from "./findings";

/** One model's diagnosis of one snapshot — what came back, judged by the app's own checks. */
export interface ModelRun {
  model: string;
  /** The refusal category, when the model declined. */
  refusal: string | null;
  /** Any other failure: an API error, non-JSON, a cut-off answer. */
  error: string | null;
  stop_reason: string | null;
  /** Findings the model returned, before the grounding check. */
  returned: number;
  /** Kept by validateFindings (P1-24), severest first. */
  findings: DiagnosisFinding[];
  /** Refused by validateFindings — evidence missing or not in the snapshot. */
  rejected: RejectedFinding[];
  summary: string;
  input_tokens: number;
  output_tokens: number;
  cost_eur: number;
}

function usageOf(calls: readonly LlmCallRecord[]) {
  return {
    input_tokens: calls.reduce(
      (s, c) => s + c.input_tokens + c.cache_creation_input_tokens + c.cache_read_input_tokens,
      0,
    ),
    output_tokens: calls.reduce((s, c) => s + c.output_tokens, 0),
    cost_eur: calls.reduce((s, c) => s + c.cost_eur, 0),
  };
}

/**
 * One model's answer, judged exactly as runDiagnosis judges it: the JSON
 * parsed, every finding through validateFindings against the snapshot's
 * keys, severest first, the summary trimmed to three sentences. A cut-off
 * or unreadable answer is a failure with its reason, never a partial read.
 */
export function toModelRun(args: {
  model: string;
  text: string;
  stop_reason: string | null;
  /** The cost lines the app logged for this call. */
  calls: readonly LlmCallRecord[];
  fact_keys: ReadonlySet<string>;
}): ModelRun {
  const base = { model: args.model, stop_reason: args.stop_reason, ...usageOf(args.calls) };
  let payload: { summary?: unknown; findings?: unknown };
  try {
    payload = parseDiagnosisText(args.text);
  } catch (e) {
    const why =
      args.stop_reason === "max_tokens"
        ? "cut off at max_tokens"
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      ...base,
      refusal: null,
      error: why,
      returned: 0,
      findings: [],
      rejected: [],
      summary: "",
    };
  }
  const { kept, rejected } = validateFindings(payload.findings, args.fact_keys);
  return {
    ...base,
    refusal: null,
    error: null,
    returned: Array.isArray(payload.findings) ? payload.findings.length : 0,
    findings: sortFindings(kept),
    rejected,
    summary: threeSentences(typeof payload.summary === "string" ? payload.summary : ""),
  };
}

/** A call that threw: a refusal (with its category) or any other failure. */
export function failedRun(
  model: string,
  error: unknown,
  calls: readonly LlmCallRecord[],
): ModelRun {
  const refusal = error instanceof DiagnosisRefusalError ? error.category : null;
  return {
    model,
    refusal,
    error: refusal === null ? (error instanceof Error ? error.message : String(error)) : null,
    stop_reason: refusal === null ? null : "refusal",
    returned: 0,
    findings: [],
    rejected: [],
    summary: "",
    ...usageOf(calls),
  };
}

export interface FindingPair {
  a: DiagnosisFinding;
  b: DiagnosisFinding;
  score: number;
  /** b's severity rank minus a's: positive means b calls it LESS severe. */
  severity_shift: number;
}

export interface FindingsMatch {
  pairs: FindingPair[];
  only_a: DiagnosisFinding[];
  only_b: DiagnosisFinding[];
}

const RANK: Readonly<Record<Severity, number>> = Object.fromEntries(
  SEVERITIES.map((s, i) => [s, i]),
) as Record<Severity, number>;

function jaccard(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const v of x) if (y.has(v)) shared++;
  return shared / (x.size + y.size - shared);
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "your",
  "you",
  "no",
  "not",
  "with",
  "its",
  "it",
  "are",
  "be",
]);

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** How alike two findings are, 0..1; 0 when they cannot be the same topic. */
export function similarity(a: DiagnosisFinding, b: DiagnosisFinding): number {
  const evidence = jaccard(new Set(a.evidence), new Set(b.evidence));
  const sameArea = a.area === b.area;
  if (!sameArea && evidence < 0.5) return 0;
  const title = jaccard(titleWords(a.title), titleWords(b.title));
  return 0.6 * evidence + 0.3 * title + (sameArea ? 0.1 : 0);
}

/** Below this, two findings are different topics. Same area alone (0.1) is not enough. */
export const MATCH_THRESHOLD = 0.2;

/** Best-first one-to-one matching of two models' findings. */
export function matchFindings(
  a: readonly DiagnosisFinding[],
  b: readonly DiagnosisFinding[],
): FindingsMatch {
  const candidates: { i: number; j: number; score: number }[] = [];
  for (const [i, fa] of a.entries()) {
    for (const [j, fb] of b.entries()) {
      const score = similarity(fa, fb);
      if (score >= MATCH_THRESHOLD) candidates.push({ i, j, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: FindingPair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    const fa = a[c.i]!;
    const fb = b[c.j]!;
    pairs.push({
      a: fa,
      b: fb,
      score: c.score,
      severity_shift: RANK[fb.severity] - RANK[fa.severity],
    });
  }
  pairs.sort((x, y) => RANK[x.a.severity] - RANK[y.a.severity]);
  return {
    pairs,
    only_a: a.filter((_, i) => !usedA.has(i)),
    only_b: b.filter((_, j) => !usedB.has(j)),
  };
}

export interface Grounding {
  returned: number;
  kept: number;
  rejected: number;
  /** kept / returned; 1 when nothing came back to check. */
  valid_rate: number;
  reasons: string[];
}

export function grounding(run: ModelRun): Grounding {
  const kept = run.findings.length;
  const rejected = run.rejected.length;
  const returned = kept + rejected;
  return {
    returned,
    kept,
    rejected,
    valid_rate: returned === 0 ? 1 : kept / returned,
    reasons: run.rejected.map((r) => r.reason),
  };
}

export interface BusinessComparison {
  label: string;
  profile_id: string;
  snapshot_id: string;
  a: ModelRun;
  b: ModelRun;
  match: FindingsMatch;
  grounding: { a: Grounding; b: Grounding };
  /** Pairs whose severity differs. */
  severity_changes: FindingPair[];
}

export function compareBusiness(args: {
  label: string;
  profile_id: string;
  snapshot_id: string;
  a: ModelRun;
  b: ModelRun;
}): BusinessComparison {
  const match = matchFindings(args.a.findings, args.b.findings);
  return {
    ...args,
    match,
    grounding: { a: grounding(args.a), b: grounding(args.b) },
    severity_changes: match.pairs.filter((p) => p.severity_shift !== 0),
  };
}

export interface RunTotals {
  businesses: number;
  findings: { a: number; b: number };
  matched: number;
  severity_changes: number;
  rejected: { a: number; b: number };
  refusals: { a: number; b: number };
  errors: { a: number; b: number };
  tokens: { a: { input: number; output: number }; b: { input: number; output: number } };
  cost_eur: { a: number; b: number };
}

export function totals(rows: readonly BusinessComparison[]): RunTotals {
  const t: RunTotals = {
    businesses: rows.length,
    findings: { a: 0, b: 0 },
    matched: 0,
    severity_changes: 0,
    rejected: { a: 0, b: 0 },
    refusals: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
    tokens: { a: { input: 0, output: 0 }, b: { input: 0, output: 0 } },
    cost_eur: { a: 0, b: 0 },
  };
  for (const r of rows) {
    for (const side of ["a", "b"] as const) {
      const run = r[side];
      t.findings[side] += run.findings.length;
      t.rejected[side] += run.rejected.length;
      if (run.refusal !== null) t.refusals[side]++;
      if (run.error !== null) t.errors[side]++;
      t.tokens[side].input += run.input_tokens;
      t.tokens[side].output += run.output_tokens;
      t.cost_eur[side] += run.cost_eur;
    }
    t.matched += r.match.pairs.length;
    t.severity_changes += r.severity_changes.length;
  }
  return t;
}

/* ── rendering ── */

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const eur = (v: number): string => `€${v.toFixed(4)}`;

function outcome(run: ModelRun): string {
  if (run.refusal !== null) return `REFUSED (${run.refusal})`;
  if (run.error !== null) return `FAILED (${run.error})`;
  return `${run.findings.length} findings`;
}

/** One business, side by side, for the terminal. */
export function renderBusinessText(c: BusinessComparison): string {
  const g = c.grounding;
  const lines = [
    `── ${c.label} (profile ${c.profile_id}, snapshot ${c.snapshot_id})`,
    `   ${c.a.model}: ${outcome(c.a)} · grounding ${g.a.kept}/${g.a.returned} valid · ${c.a.input_tokens} in / ${c.a.output_tokens} out · ${eur(c.a.cost_eur)} · stop ${c.a.stop_reason ?? "—"}`,
    `   ${c.b.model}: ${outcome(c.b)} · grounding ${g.b.kept}/${g.b.returned} valid · ${c.b.input_tokens} in / ${c.b.output_tokens} out · ${eur(c.b.cost_eur)} · stop ${c.b.stop_reason ?? "—"}`,
    `   matched by topic: ${c.match.pairs.length} · only ${c.a.model}: ${c.match.only_a.length} · only ${c.b.model}: ${c.match.only_b.length} · severity changed: ${c.severity_changes.length}`,
  ];
  for (const p of c.match.pairs) {
    const shift = p.severity_shift === 0 ? "=" : `${p.a.severity} → ${p.b.severity}`;
    lines.push(`     ≈ [${p.a.area}] ${p.a.title}  ⇄  ${p.b.title}  (${shift})`);
  }
  for (const f of c.match.only_a)
    lines.push(`     − [${f.area}/${f.severity}] ${f.title}  (only ${c.a.model})`);
  for (const f of c.match.only_b)
    lines.push(`     + [${f.area}/${f.severity}] ${f.title}  (only ${c.b.model})`);
  for (const r of g.a.reasons) lines.push(`     ✗ ${c.a.model} rejected: ${r}`);
  for (const r of g.b.reasons) lines.push(`     ✗ ${c.b.model} rejected: ${r}`);
  return lines.join("\n");
}

export function renderTotalsText(t: RunTotals, models: { a: string; b: string }): string {
  return [
    `TOTAL over ${t.businesses} business(es)`,
    `   findings ${models.a} ${t.findings.a} · ${models.b} ${t.findings.b} · matched ${t.matched} · severity changed ${t.severity_changes}`,
    `   grounding rejects ${models.a} ${t.rejected.a} · ${models.b} ${t.rejected.b}`,
    `   refusals ${models.a} ${t.refusals.a} · ${models.b} ${t.refusals.b} · other failures ${t.errors.a} / ${t.errors.b}`,
    `   tokens ${models.a} ${t.tokens.a.input} in / ${t.tokens.a.output} out · ${models.b} ${t.tokens.b.input} in / ${t.tokens.b.output} out`,
    `   cost ${models.a} ${eur(t.cost_eur.a)} · ${models.b} ${eur(t.cost_eur.b)}`,
  ].join("\n");
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderMarkdown(args: {
  generated_at: string;
  models: { a: string; b: string };
  rows: readonly BusinessComparison[];
  sonnet?: SonnetReport | null;
}): string {
  const { a, b } = args.models;
  const t = totals(args.rows);
  const out: string[] = [
    `# Diagnosis recalibration: ${a} vs ${b}`,
    "",
    `Generated ${args.generated_at}. Each business's stored snapshot was diagnosed by both models with the same prompt; nothing was written to any profile. Findings are kept or rejected by the app's own grounding check (P1-24).`,
    "",
    "## Totals",
    "",
    `| | ${a} | ${b} |`,
    "|---|---|---|",
    `| Findings kept | ${t.findings.a} | ${t.findings.b} |`,
    `| Grounding rejects | ${t.rejected.a} | ${t.rejected.b} |`,
    `| Refusals | ${t.refusals.a} | ${t.refusals.b} |`,
    `| Other failures | ${t.errors.a} | ${t.errors.b} |`,
    `| Input tokens | ${t.tokens.a.input} | ${t.tokens.b.input} |`,
    `| Output tokens | ${t.tokens.a.output} | ${t.tokens.b.output} |`,
    `| Cost | ${eur(t.cost_eur.a)} | ${eur(t.cost_eur.b)} |`,
    "",
    `Matched by topic: ${t.matched}. Severity changed on ${t.severity_changes} matched finding(s).`,
  ];
  for (const c of args.rows) {
    const g = c.grounding;
    out.push(
      "",
      `## ${cell(c.label)}`,
      "",
      `Profile \`${c.profile_id}\`, snapshot \`${c.snapshot_id}\`.`,
      "",
      `| | ${a} | ${b} |`,
      "|---|---|---|",
      `| Outcome | ${cell(outcome(c.a))} | ${cell(outcome(c.b))} |`,
      `| Grounding valid | ${g.a.kept}/${g.a.returned} (${pct(g.a.valid_rate)}) | ${g.b.kept}/${g.b.returned} (${pct(g.b.valid_rate)}) |`,
      `| Stop reason | ${c.a.stop_reason ?? "—"} | ${c.b.stop_reason ?? "—"} |`,
      `| Tokens in / out | ${c.a.input_tokens} / ${c.a.output_tokens} | ${c.b.input_tokens} / ${c.b.output_tokens} |`,
      `| Cost | ${eur(c.a.cost_eur)} | ${eur(c.b.cost_eur)} |`,
      `| Summary | ${cell(c.a.summary) || "—"} | ${cell(c.b.summary) || "—"} |`,
    );
    out.push("", "| Area | " + a + " | " + b + " | Severity |", "|---|---|---|---|");
    for (const p of c.match.pairs) {
      const sev = p.severity_shift === 0 ? p.a.severity : `${p.a.severity} → ${p.b.severity}`;
      out.push(`| ${p.a.area} | ${cell(p.a.title)} | ${cell(p.b.title)} | ${sev} |`);
    }
    for (const f of c.match.only_a)
      out.push(`| ${f.area} | ${cell(f.title)} | — | ${f.severity} |`);
    for (const f of c.match.only_b)
      out.push(`| ${f.area} | — | ${cell(f.title)} | ${f.severity} |`);
    const rejects = [
      ...g.a.reasons.map((r) => `- ${a} rejected: ${cell(r)}`),
      ...g.b.reasons.map((r) => `- ${b} rejected: ${cell(r)}`),
    ];
    if (rejects.length > 0) out.push("", ...rejects);
  }
  if (args.sonnet) out.push("", renderSonnetMarkdown(args.sonnet));
  return `${out.join("\n")}\n`;
}

/* ── --sonnet: the interviewer's next-question choice ── */

export interface PickRun {
  model: string;
  /** null: the interview is complete — no call was made. */
  question_id: string | null;
  reason: string;
  /** The model's pick was outside the candidates and the deterministic fallback stood in. */
  fallback: boolean;
  error: string | null;
  calls: number;
  cache_read_input_tokens: number;
  cost_eur: number;
}

export interface PickComparison {
  label: string;
  profile_id: string;
  candidates: number;
  a: PickRun;
  b: PickRun;
  same: boolean;
}

export function comparePicks(args: {
  label: string;
  profile_id: string;
  candidates: number;
  a: PickRun;
  b: PickRun;
}): PickComparison {
  return {
    ...args,
    same: args.a.question_id !== null && args.a.question_id === args.b.question_id,
  };
}

export interface SonnetReport {
  models: { a: string; b: string };
  rows: PickComparison[];
}

export function sonnetTotals(r: SonnetReport): {
  compared: number;
  agreed: number;
  fallbacks: { a: number; b: number };
  errors: { a: number; b: number };
  cache_read: { a: number; b: number };
  cost_eur: { a: number; b: number };
} {
  const sum = (side: "a" | "b", f: (p: PickRun) => number) =>
    r.rows.reduce((s, row) => s + f(row[side]), 0);
  return {
    compared: r.rows.length,
    agreed: r.rows.filter((row) => row.same).length,
    fallbacks: { a: sum("a", (p) => Number(p.fallback)), b: sum("b", (p) => Number(p.fallback)) },
    errors: {
      a: sum("a", (p) => Number(p.error !== null)),
      b: sum("b", (p) => Number(p.error !== null)),
    },
    cache_read: {
      a: sum("a", (p) => p.cache_read_input_tokens),
      b: sum("b", (p) => p.cache_read_input_tokens),
    },
    cost_eur: { a: sum("a", (p) => p.cost_eur), b: sum("b", (p) => p.cost_eur) },
  };
}

function pickText(p: PickRun): string {
  if (p.error !== null) return `FAILED (${p.error})`;
  if (p.question_id === null) return "interview complete";
  return `${p.question_id}${p.fallback ? " (fallback)" : ""}`;
}

export function renderPicksText(r: SonnetReport): string {
  const lines = r.rows.map(
    (row) =>
      `── ${row.label} (${row.candidates} candidates): ${r.models.a} ${pickText(row.a)} · ${r.models.b} ${pickText(row.b)} · ${row.same ? "SAME" : "DIFFERENT"}` +
      `\n   ${r.models.a}: ${row.a.reason}\n   ${r.models.b}: ${row.b.reason}`,
  );
  const t = sonnetTotals(r);
  lines.push(
    `TOTAL: same pick on ${t.agreed}/${t.compared} · fallbacks ${t.fallbacks.a} / ${t.fallbacks.b} · failures ${t.errors.a} / ${t.errors.b}` +
      ` · cache reads ${t.cache_read.a} / ${t.cache_read.b} tokens · cost ${eur(t.cost_eur.a)} / ${eur(t.cost_eur.b)}`,
  );
  return lines.join("\n");
}

export function renderSonnetMarkdown(r: SonnetReport): string {
  const { a, b } = r.models;
  const t = sonnetTotals(r);
  const out = [
    `## Interviewer: ${a} vs ${b}`,
    "",
    `The next question each model picked from the same candidates. Same pick on ${t.agreed} of ${t.compared}. Cache reads (rule 8): ${a} ${t.cache_read.a} tokens, ${b} ${t.cache_read.b} tokens.`,
    "",
    `| Business | Candidates | ${a} | ${b} | Same |`,
    "|---|---|---|---|---|",
    ...r.rows.map(
      (row) =>
        `| ${cell(row.label)} | ${row.candidates} | ${cell(pickText(row.a))} | ${cell(pickText(row.b))} | ${row.same ? "yes" : "no"} |`,
    ),
    "",
    `| | ${a} | ${b} |`,
    "|---|---|---|",
    `| Fallbacks | ${t.fallbacks.a} | ${t.fallbacks.b} |`,
    `| Failures | ${t.errors.a} | ${t.errors.b} |`,
    `| Cost | ${eur(t.cost_eur.a)} | ${eur(t.cost_eur.b)} |`,
  ];
  return out.join("\n");
}

/* ── the honest estimate, printed before anything is spent ── */

/** Conservative: ~3 characters a token over-counts English (~4) on purpose. */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}
