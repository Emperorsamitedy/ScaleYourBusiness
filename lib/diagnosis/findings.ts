// Diagnosis findings — Session E (P1-22..27) / build-sequence step 42.
//
// The only Opus workload in the product (CLAUDE.md routing), and the one
// place the system is allowed to exercise judgement about a business. Two
// rules keep that judgement honest:
//
//   1. EVIDENCE IS ENFORCED IN CODE, NOT IN THE PROMPT (P1-24). A finding
//      whose evidence array is empty, or which references a field the
//      snapshot does not hold, is REJECTED — never repaired, never
//      quietly dropped. The rejects are returned alongside the keepers so
//      a bad batch is visible, not smoothed over.
//   2. The model reads a SNAPSHOT, not the live profile. The exact facts
//      a finding pointed at can be reproduced later, byte for byte.
//
// PROMPT STATUS: CALIBRATED (2026-09-11) against five real businesses
// run through production under the re-scoped P0-86 — physical DTC small
// (FTGU) and at scale with subscriptions (Beardbrand), booking service
// (Match Artist), digital courses (Justin Welsh), plus Ember & Oak.
// Across all five: zero invented numbers, every finding evidence-cited,
// refusals chosen over guesses, and cross-fact reasoning that held up
// (inventory history → missing tracking; international digital sales →
// VAT exposure; a service-branch answer → the key-man critical). The
// two changes real runs DID force were mechanical, not prompt: the
// threeSentences decimal split and widening close_gap to fillable keys.
// Recalibrate again only when a real run produces a grounding failure.

import { computeCompleteness } from "../scorer/completeness";
import { displaySourceKind } from "../connectors/measured";
import type { Field } from "../core/field";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { repr } from "../profile/factsheet";
import { openFindings } from "../validation/engine";

/** CLAUDE.md routing: Opus only for the diagnosis report. */
export const DIAGNOSIS_MODEL = "claude-opus-4-8";

export class DiagnosisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosisError";
  }
}

/* ── the types (data-model §10) ── */

export const AREAS = [
  "marketing",
  "sales",
  "finance",
  "operations",
  "product",
  "customers",
] as const;
export type Area = (typeof AREAS)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** §7 of the UX spec: severity is a mono LABEL, never a colour. The
 * report screen renders these strings in the mono face and nothing else —
 * there is deliberately no colour map to import. */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface DiagnosisFinding {
  area: Area;
  title: string;
  detail: string;
  /** Every claim traces to snapshot fields — enforced in code (P1-24). */
  evidence: string[];
  severity: Severity;
  confidence: number;
}

export interface RejectedFinding {
  /** The model's raw output, kept for the audit trail. */
  raw: unknown;
  reason: string;
}

export interface DiagnosisResult {
  snapshot_id: string;
  /** Three plain-language sentences (§7), trimmed in code, never padded. */
  summary: string;
  /** Valid findings, severest first. */
  findings: DiagnosisFinding[];
  /** What the code refused, and why — a bad batch is visible, not repaired. */
  rejected: RejectedFinding[];
  completeness: number;
  calls: readonly LlmCallRecord[];
  cost_eur: number;
}

/* ── the model's output contract ── */

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" as const },
    findings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          area: { type: "string" as const, enum: [...AREAS] },
          title: { type: "string" as const },
          detail: { type: "string" as const },
          evidence: { type: "array" as const, items: { type: "string" as const } },
          severity: { type: "string" as const, enum: [...SEVERITIES] },
          confidence: { type: "number" as const },
        },
        required: ["area", "title", "detail", "evidence", "severity", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
};

// Calibrated — see the header for the five-run evidence.
const SYSTEM = `You are diagnosing a small business from its profile: a list of facts, each carrying its field key, value, status, confidence, and source.

Write findings — the specific places this business is losing or risking money — and a summary.

Rules that are checked by code after you answer, so violating them wastes the entire run:
- evidence: every finding lists the field keys it rests on, copied EXACTLY from the facts given. A finding with no evidence, or citing a key not in the list, is discarded.
- Only claim what the evidence supports. A gap (status unknown/never asked) can itself be a finding — "you don't know your unit cost" is a legitimate, evidenced finding citing that field.
- Never invent numbers. Reference the profile's own figures.
- severity reflects money at stake relative to this business's revenue, not drama.
- confidence reflects the weakest evidence you cite, not your prose.
- summary: exactly three sentences, plain language, no jargon, addressed to the owner as "you". The single most expensive problem first.

Write 3 to 7 findings. Fewer, well-evidenced findings beat a padded list.`;

export type DiagnosisLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

export const liveDiagnosisLlm: DiagnosisLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: DIAGNOSIS_MODEL,
    max_tokens: 8_000,
    // Opus 4.8 runs without thinking unless asked; the diagnosis is the
    // one workload where the thinking is worth its tokens.
    thinking: { type: "adaptive" },
    system,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "diagnosis",
    account_id: accountId,
    model: DIAGNOSIS_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, calls: [record] };
};

/* ── deterministic machinery, exported for tests ── */

/** P1-24: the code, not the prompt, decides what survives. */
export function validateFindings(
  raw: unknown,
  knownFieldKeys: ReadonlySet<string>,
): { kept: DiagnosisFinding[]; rejected: RejectedFinding[] } {
  const kept: DiagnosisFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const list = Array.isArray(raw) ? raw : [];

  for (const item of list) {
    const f = item as Partial<DiagnosisFinding>;
    const reject = (reason: string): void => {
      rejected.push({ raw: item, reason });
    };

    if (typeof f.title !== "string" || f.title.trim() === "") {
      reject("no title");
      continue;
    }
    if (typeof f.detail !== "string" || f.detail.trim() === "") {
      reject(`"${f.title}" · no detail`);
      continue;
    }
    if (!AREAS.includes(f.area as Area)) {
      reject(`"${f.title}" · unknown area "${String(f.area)}"`);
      continue;
    }
    if (!SEVERITIES.includes(f.severity as Severity)) {
      reject(`"${f.title}" · unknown severity "${String(f.severity)}"`);
      continue;
    }
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
      reject(`"${f.title}" · confidence out of range`);
      continue;
    }
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
      reject(`"${f.title}" · empty evidence — a finding without evidence is not a finding`);
      continue;
    }
    const missing = f.evidence.filter((key) => typeof key !== "string" || !knownFieldKeys.has(key));
    if (missing.length > 0) {
      reject(`"${f.title}" · evidence not in the snapshot: ${missing.join(", ")}`);
      continue;
    }

    kept.push({
      area: f.area as Area,
      title: f.title.trim(),
      detail: f.detail.trim(),
      evidence: f.evidence as string[],
      severity: f.severity as Severity,
      confidence: f.confidence,
    });
  }

  return { kept, rejected };
}

/** P1-25: severest first; ties keep the model's order (stable sort). */
export function sortFindings(findings: readonly DiagnosisFinding[]): DiagnosisFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** §7: three sentences. Trimmed in code — never padded, never trusted.
 * A sentence ends at .!? followed by whitespace and a capital — NOT at
 * the period inside "0.5L" or "4.5 million", which a naive split eats
 * (caught on the first live run, where the summary began mid-word). */
export function threeSentences(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = clean.split(/(?<=[.!?])\s+(?=[A-ZÀ-ÞĀ-Ž"“(])/u);
  return parts.slice(0, 3).join(" ");
}

/** One fact, one line — the profile as the model sees it. */
export function factLine(key: string, field: Field<unknown>): string {
  // A connector measurement reads as source=connector, not inferred: to the
  // diagnosis it is the strongest evidence in the profile, not a derivation
  // from the owner's other answers (Phase 2, P2-10).
  const source = displaySourceKind(field.source);
  const value =
    field.status === "answered" || field.status === "inferred"
      ? (repr(field.value) ?? "—")
      : `(${field.status})`;
  return `${key} = ${value} · status=${field.status} · confidence=${field.confidence} · source=${source}`;
}

/* ── the run ── */

export async function runDiagnosis(args: {
  accountId: string;
  profileId: string;
  llm?: DiagnosisLlm;
}): Promise<DiagnosisResult> {
  // The diagnosis reads a frozen snapshot — reproducible, never shifting.
  const summary = await ensureSnapshot(args.profileId, "report");
  const [view, completeness, validation] = await Promise.all([
    readSnapshot(summary.id),
    computeCompleteness(args.profileId),
    openFindings(args.profileId),
  ]);

  if (view.facts.size === 0) {
    throw new DiagnosisError("the profile holds no facts — nothing to diagnose");
  }

  const factKeys = new Set(view.facts.keys());
  const lines = [...view.facts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, field]) => factLine(key, field));

  const user = [
    `PROFILE (${lines.length} facts, completeness ${(completeness.overall * 100).toFixed(0)}%):`,
    ...lines,
    "",
    validation.length > 0
      ? `VALIDATION FINDINGS ALREADY DETECTED BY RULES (${validation.length}):`
      : "No validation findings are currently open.",
    ...validation.map(
      (v) =>
        `- [${v.kind}/${v.severity}] ${v.rule_id}: fields ${(v.field_keys as string[]).join(", ")}`,
    ),
  ].join("\n");

  const llm = args.llm ?? liveDiagnosisLlm;
  const { text, calls } = await llm({ system: SYSTEM, user, accountId: args.accountId });

  let payload: { summary?: unknown; findings?: unknown };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new DiagnosisError(`diagnosis returned non-JSON: ${text.slice(0, 160)}`);
  }

  const { kept, rejected } = validateFindings(payload.findings, factKeys);
  if (kept.length === 0) {
    throw new DiagnosisError(
      `every finding was rejected (${rejected.map((r) => r.reason).join(" | ")})`,
    );
  }

  return {
    snapshot_id: summary.id,
    summary: threeSentences(typeof payload.summary === "string" ? payload.summary : ""),
    findings: sortFindings(kept),
    rejected,
    completeness: completeness.overall,
    calls,
    // P1-27: measured against the €1.78 estimate, per run.
    cost_eur: calls.reduce((sum, c) => sum + c.cost_eur, 0),
  };
}
