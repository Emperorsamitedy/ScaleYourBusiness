// Recommendations — Session F (P1-28..33) / build-sequence step 43.
//
// The dividing line this file exists to hold: THE MODEL FRAMES, THE CODE
// PROVES (P1-30). The model picks the lever — which offer, which price
// change, which gap to close — and writes the prose. Every number in a
// scenario comes out of deterministic arithmetic over snapshot facts:
// the output schema has no field where the model could put a profit
// figure or a break-even percentage, so inventing one is structurally
// impossible rather than merely forbidden.
//
// Assumption sensitivity (P1-31) is computed, not asserted: how much the
// conclusion moves when the input does is a derivative, not an opinion.
//
// ⚠ PROMPT STATUS: PROVISIONAL — same standing as findings.ts. Built
// ahead of the P0-86 gate at the owner's decision; the machinery is
// prompt-independent, the SYSTEM text is not tuned until real intakes
// exist.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, bankEntitySchemas, bankVersions, businessProfiles } from "../../db/schema";
import type { Money } from "../core/money";
import { money, subtract } from "../core/money";
import { computeEconomics } from "../economics/unit-economics";
import type { OfferEconomics } from "../economics/unit-economics";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { applicableQuestions } from "../resolver/applicability";
import type { DiagnosisFinding } from "./findings";
import { DIAGNOSIS_MODEL, DiagnosisError } from "./findings";

/* ── the types (data-model §10) ── */

export interface Assumption {
  statement: string;
  value: number | Money | null;
  /** The snapshot field the value came from; null for a true assumption. */
  source_field: string | null;
  /** How much the conclusion depends on it — computed where possible. */
  sensitivity: "high" | "medium" | "low";
}

export interface ScenarioOutcome {
  case: "base" | "downside" | "upside";
  statement: string;
  /** Monthly profit change vs today. Null only in qualitative scenarios. */
  profit_delta_monthly: Money | null;
  /** The arithmetic, with the real numbers in it. Null when there is none. */
  formula: string | null;
}

export interface ScenarioBlock {
  assumptions: Assumption[];
  base_case: ScenarioOutcome;
  downside_case: ScenarioOutcome;
  upside_case: ScenarioOutcome;
  /** "requires ≥124% volume lift to break even — 900 ÷ 401 …" */
  breakeven_condition: string;
}

export interface Recommendation {
  /** Indexes into the findings this run was given — P1-29. */
  addresses: number[];
  title: string;
  rationale: string;
  scenario: ScenarioBlock;
  effort: "low" | "medium" | "high";
  reversibility: {
    level: "easy" | "moderate" | "hard";
    /** P1-32: what happens if the owner changes their mind. */
    if_you_change_your_mind: string;
  };
  /** P1-31: one line per high-sensitivity assumption, for inline display. */
  sensitivity_callouts: string[];
}

export interface RejectedRecommendation {
  raw: unknown;
  reason: string;
}

export interface RecommendationsResult {
  snapshot_id: string;
  recommendations: Recommendation[];
  rejected: RejectedRecommendation[];
  calls: readonly LlmCallRecord[];
  cost_eur: number;
}

/* ── the arithmetic (P1-30): pure, exported, provable ── */

const fmt = (minor: number, currency: string): string =>
  `${Math.round(minor / 100).toLocaleString("en-US").replace(/,/g, " ")} ${currency}`;

const pct1 = (n: number): string => `${(Math.round(n * 10) / 10).toLocaleString("en-US")}%`;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export interface PriceChangeInputs {
  offer: OfferEconomics;
  /** The lever the model chose: −10 means a 10% discount. */
  change_pct: number;
  /** Volume responses per case, in percent — genuine assumptions. */
  volume_response: { base_pct: number; downside_pct: number; upside_pct: number };
}

/**
 * Every figure in the returned block is derived here from snapshot facts
 * and the two levers above. P1-33's contract: a discount states the
 * volume lift required to break even, with the arithmetic shown.
 */
export function priceChangeScenario(inputs: PriceChangeInputs): ScenarioBlock {
  const { offer, change_pct, volume_response } = inputs;
  if (offer.cost_to_deliver === null) {
    throw new ScenarioError(`"${offer.name}" has no cost_to_deliver — nothing provable`);
  }
  if (offer.volume === null || offer.volume <= 0) {
    throw new ScenarioError(`"${offer.name}" has no volume — nothing provable`);
  }
  if (offer.cost_to_deliver.currency !== offer.price.currency) {
    throw new ScenarioError(
      `"${offer.name}" prices in ${offer.price.currency} but costs in ${offer.cost_to_deliver.currency} — refusing to blend currencies`,
    );
  }
  if (change_pct === 0 || change_pct < -90 || change_pct > 200) {
    throw new ScenarioError(`implausible price change ${change_pct}%`);
  }

  const currency = offer.price.currency;
  const volume = offer.volume;
  const marginNow = subtract(offer.price, offer.cost_to_deliver).amount_minor;
  const priceNew = Math.round(offer.price.amount_minor * (1 + change_pct / 100));
  const marginNew = priceNew - offer.cost_to_deliver.amount_minor;
  const profitNow = marginNow * volume;

  // ── break-even, proven ──
  let breakeven: string;
  if (marginNew <= 0) {
    breakeven =
      `no volume can break even — at ${fmt(priceNew, currency)} the price is ` +
      `${marginNew === 0 ? "exactly" : "below"} the ${fmt(offer.cost_to_deliver.amount_minor, currency)} unit cost`;
  } else if (change_pct < 0) {
    const liftPct = (marginNow / marginNew - 1) * 100;
    breakeven =
      `requires ≥${pct1(liftPct)} volume lift to break even — margin per unit falls ` +
      `${fmt(marginNow, currency)} → ${fmt(marginNew, currency)}, so matching today's ` +
      `${fmt(profitNow, currency)}/month takes ${Math.ceil((volume * marginNow) / marginNew)} units ` +
      `vs ${volume} today (${fmt(marginNow, currency)} ÷ ${fmt(marginNew, currency)} = ${(marginNow / marginNew).toFixed(2)}×)`;
  } else {
    const tolerablePct = (1 - marginNow / marginNew) * 100;
    breakeven =
      `sales can fall up to ${pct1(tolerablePct)} before this costs you anything — margin per unit rises ` +
      `${fmt(marginNow, currency)} → ${fmt(marginNew, currency)} ` +
      `(1 − ${fmt(marginNow, currency)} ÷ ${fmt(marginNew, currency)} = ${pct1(tolerablePct)})`;
  }

  // ── the three cases, each with its arithmetic ──
  const outcome = (kase: ScenarioOutcome["case"], responsePct: number): ScenarioOutcome => {
    const units = Math.round(volume * (1 + responsePct / 100));
    const delta = marginNew * units - profitNow;
    return {
      case: kase,
      statement:
        `volume ${responsePct === 0 ? "unchanged" : `${responsePct > 0 ? "+" : ""}${pct1(responsePct)}`}` +
        ` → ${delta >= 0 ? "+" : "−"}${fmt(Math.abs(delta), currency)}/month vs today`,
      profit_delta_monthly: money(delta, currency),
      formula:
        `${fmt(marginNew, currency)} × ${units} units − ${fmt(marginNow, currency)} × ${volume} units` +
        ` = ${delta >= 0 ? "+" : "−"}${fmt(Math.abs(delta), currency)}`,
    };
  };

  // ── sensitivity, computed (P1-31): thin new margins make everything
  // touchy. If the post-change margin is under 15% of price, small errors
  // in cost or volume response swing the conclusion — that IS high. ──
  const thin = marginNew > 0 && marginNew / priceNew < 0.15;
  const costSensitivity: Assumption["sensitivity"] = thin ? "high" : "medium";

  const assumptions: Assumption[] = [
    {
      statement: `${offer.name} sells at ${fmt(offer.price.amount_minor, currency)}`,
      value: offer.price,
      source_field: `offers.${offer.offer_id}.price`,
      sensitivity: "low",
    },
    {
      statement: `each unit costs ${fmt(offer.cost_to_deliver.amount_minor, currency)} to deliver`,
      value: offer.cost_to_deliver,
      source_field: `offers.${offer.offer_id}.cost_to_deliver`,
      sensitivity: costSensitivity,
    },
    {
      statement: `you sell ${volume} units per month`,
      value: volume,
      source_field: `offers.${offer.offer_id}.volume_period`,
      sensitivity: "medium",
    },
    {
      statement: `customers respond to the new price with ${pct1(volume_response.base_pct)} volume change (downside ${pct1(volume_response.downside_pct)}, upside ${pct1(volume_response.upside_pct)})`,
      value: volume_response.base_pct,
      source_field: null, // a true assumption — nothing in the profile knows this
      sensitivity: "high",
    },
  ];

  return {
    assumptions,
    base_case: outcome("base", volume_response.base_pct),
    downside_case: outcome("downside", volume_response.downside_pct),
    upside_case: outcome("upside", volume_response.upside_pct),
    breakeven_condition: breakeven,
  };
}

/** A gap-closing recommendation risks time, not margin — qualitative. */
export function closeGapScenario(fieldKeys: string[], why: string): ScenarioBlock {
  const q = (kase: ScenarioOutcome["case"], statement: string): ScenarioOutcome => ({
    case: kase,
    statement,
    profit_delta_monthly: null,
    formula: null,
  });
  return {
    assumptions: [
      {
        statement: why,
        value: null,
        source_field: fieldKeys[0] ?? null,
        sensitivity: "low",
      },
    ],
    base_case: q("base", "the profile gains the missing facts and the next diagnosis sharpens"),
    downside_case: q("downside", "a few minutes spent answering, nothing else at risk"),
    upside_case: q("upside", "a finding currently blocked by the gap becomes provable"),
    breakeven_condition: "nothing to break even — this costs time, not margin",
  };
}

/** P1-31: the inline callouts, one per high-sensitivity assumption. */
export function sensitivityCallouts(assumptions: readonly Assumption[]): string[] {
  return assumptions
    .filter((a) => a.sensitivity === "high")
    .map((a) => `this depends heavily on: ${a.statement}`);
}

/* ── what the model may say (note what it may NOT: any money figure) ── */

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    recommendations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          addresses: { type: "array" as const, items: { type: "integer" as const } },
          title: { type: "string" as const },
          rationale: { type: "string" as const },
          effort: { type: "string" as const, enum: ["low", "medium", "high"] },
          reversibility_level: { type: "string" as const, enum: ["easy", "moderate", "hard"] },
          if_you_change_your_mind: { type: "string" as const },
          scenario: {
            type: "object" as const,
            properties: {
              kind: { type: "string" as const, enum: ["price_change", "close_gap"] },
              offer_id: { type: ["string", "null"] as unknown as "string" },
              change_pct: { type: ["number", "null"] as unknown as "number" },
              volume_response_base_pct: { type: ["number", "null"] as unknown as "number" },
              volume_response_downside_pct: { type: ["number", "null"] as unknown as "number" },
              volume_response_upside_pct: { type: ["number", "null"] as unknown as "number" },
              gap_field_keys: {
                type: ["array", "null"] as unknown as "array",
                items: { type: "string" as const },
              },
              gap_why: { type: ["string", "null"] as unknown as "string" },
            },
            required: [
              "kind",
              "offer_id",
              "change_pct",
              "volume_response_base_pct",
              "volume_response_downside_pct",
              "volume_response_upside_pct",
              "gap_field_keys",
              "gap_why",
            ],
            additionalProperties: false,
          },
        },
        required: [
          "addresses",
          "title",
          "rationale",
          "effort",
          "reversibility_level",
          "if_you_change_your_mind",
          "scenario",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["recommendations"],
  additionalProperties: false,
};

// PROVISIONAL — see the header.
const SYSTEM = `You write recommendations for a small business, addressing findings from its diagnosis.

You choose the lever; the arithmetic is computed by code afterwards. You CANNOT state profit figures, break-even percentages, or any money amount — the output has no field for them, and your rationale must not contain invented numbers either.

Each recommendation:
- addresses: the indexes of the findings it responds to (from the numbered list given). At least one; only indexes that exist.
- scenario.kind "price_change": pick offer_id from the OFFERS table given, a change_pct (negative = discount), and three volume-response percentages (base / downside / upside) — your honest assumption of how customers react, which will be labelled as an assumption and challenged.
- scenario.kind "close_gap": name the gap_field_keys worth filling and gap_why, when the finding is about what the owner does not know. Keys may come from the FIELD KEYS list or be a missing-but-fillable key shown against an offer (e.g. its UNKNOWN cost).
- if_you_change_your_mind: what actually happens if the owner reverses this later. Be concrete.
- Only recommend price changes on offers whose table row shows both cost and volume — others cannot be proven and will be rejected.

2 to 4 recommendations. The most valuable first.`;

export type RecommendationsLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

export const liveRecommendationsLlm: RecommendationsLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: DIAGNOSIS_MODEL,
    max_tokens: 6_000,
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

/* ── validation + computation: the code decides (P1-29/30) ── */

interface RawRecommendation {
  addresses?: unknown;
  title?: unknown;
  rationale?: unknown;
  effort?: unknown;
  reversibility_level?: unknown;
  if_you_change_your_mind?: unknown;
  scenario?: {
    kind?: unknown;
    offer_id?: unknown;
    change_pct?: unknown;
    volume_response_base_pct?: unknown;
    volume_response_downside_pct?: unknown;
    volume_response_upside_pct?: unknown;
    gap_field_keys?: unknown;
    gap_why?: unknown;
  };
}

export function buildRecommendations(
  raw: unknown,
  findingCount: number,
  offersById: ReadonlyMap<string, OfferEconomics>,
  /** Keys a close_gap may cite: recorded facts PLUS fillable-but-missing
   * ones (applicable questions, entity schema fields on real entities).
   * A gap-closing recommendation must be allowed to name the very field
   * that is absent — the first live run rejected a good recommendation
   * for citing the missing cost it wanted recorded. */
  fillableFieldKeys: ReadonlySet<string>,
): { kept: Recommendation[]; rejected: RejectedRecommendation[] } {
  const kept: Recommendation[] = [];
  const rejected: RejectedRecommendation[] = [];
  const list = Array.isArray(raw) ? raw : [];

  for (const item of list) {
    const r = item as RawRecommendation;
    const reject = (reason: string): void => {
      rejected.push({ raw: item, reason });
    };
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (title === "") {
      reject("no title");
      continue;
    }

    // P1-29: only findings that actually exist.
    const addresses = Array.isArray(r.addresses)
      ? r.addresses.filter((n): n is number => Number.isInteger(n))
      : [];
    if (addresses.length === 0 || addresses.some((n) => n < 0 || n >= findingCount)) {
      reject(`"${title}" · addresses findings that do not exist`);
      continue;
    }

    // P1-32: reversibility is not optional prose.
    const undo = typeof r.if_you_change_your_mind === "string" ? r.if_you_change_your_mind.trim() : "";
    const level = r.reversibility_level;
    if (undo === "" || (level !== "easy" && level !== "moderate" && level !== "hard")) {
      reject(`"${title}" · reversibility missing — every recommendation says what undo looks like`);
      continue;
    }
    const effort = r.effort;
    if (effort !== "low" && effort !== "medium" && effort !== "high") {
      reject(`"${title}" · effort missing`);
      continue;
    }

    // P1-30: the scenario is computed here or the recommendation dies.
    let scenario: ScenarioBlock;
    const s = r.scenario ?? {};
    try {
      if (s.kind === "price_change") {
        const offer = typeof s.offer_id === "string" ? offersById.get(s.offer_id) : undefined;
        if (!offer) throw new ScenarioError(`offer "${String(s.offer_id)}" is not in the profile`);
        if (
          typeof s.change_pct !== "number" ||
          typeof s.volume_response_base_pct !== "number" ||
          typeof s.volume_response_downside_pct !== "number" ||
          typeof s.volume_response_upside_pct !== "number"
        ) {
          throw new ScenarioError("price_change needs change_pct and three volume responses");
        }
        scenario = priceChangeScenario({
          offer,
          change_pct: s.change_pct,
          volume_response: {
            base_pct: s.volume_response_base_pct,
            downside_pct: s.volume_response_downside_pct,
            upside_pct: s.volume_response_upside_pct,
          },
        });
      } else if (s.kind === "close_gap") {
        const keys = Array.isArray(s.gap_field_keys)
          ? s.gap_field_keys.filter((k): k is string => typeof k === "string")
          : [];
        const bogus = keys.filter((k) => !fillableFieldKeys.has(k));
        if (keys.length === 0) throw new ScenarioError("close_gap names no fields");
        if (bogus.length > 0) {
          throw new ScenarioError(`close_gap cites fields that are neither recorded nor fillable: ${bogus.join(", ")}`);
        }
        scenario = closeGapScenario(keys, typeof s.gap_why === "string" ? s.gap_why : title);
      } else {
        throw new ScenarioError(`unknown scenario kind "${String(s.kind)}"`);
      }
    } catch (error) {
      if (error instanceof ScenarioError) {
        reject(`"${title}" · ${error.message}`);
        continue;
      }
      throw error;
    }

    kept.push({
      addresses,
      title,
      rationale: typeof r.rationale === "string" ? r.rationale.trim() : "",
      scenario,
      effort,
      reversibility: { level, if_you_change_your_mind: undo },
      sensitivity_callouts: sensitivityCallouts(scenario.assumptions),
    });
  }

  return { kept, rejected };
}

/* ── the run ── */

export async function runRecommendations(args: {
  accountId: string;
  profileId: string;
  findings: readonly DiagnosisFinding[];
  llm?: RecommendationsLlm;
}): Promise<RecommendationsResult> {
  if (args.findings.length === 0) {
    throw new DiagnosisError("no findings to address — run the diagnosis first");
  }

  const summary = await ensureSnapshot(args.profileId, "report");
  const view = await readSnapshot(summary.id);
  const [row] = await db
    .select({ currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, args.profileId));
  const economics = computeEconomics(view, row?.currency ?? "EUR");
  const offersById = new Map(economics.offers.map((o) => [o.offer_id, o]));

  // What a close_gap may point at: everything recorded, everything an
  // applicable question could write, and every schema field of every
  // entity that actually exists — the missing ones most of all.
  const fillable = new Set(view.facts.keys());
  for (const q of await applicableQuestions(args.profileId)) fillable.add(q.writes_to);
  const [currentBank] = await db
    .select()
    .from(bankVersions)
    .where(eq(bankVersions.is_current, true));
  if (currentBank) {
    const schemas = await db
      .select()
      .from(bankEntitySchemas)
      .where(eq(bankEntitySchemas.bank_version, currentBank.version));
    const fieldsBySchema = new Map(
      schemas.map((r) => [r.key, (r.fields as { key: string }[]).map((f) => f.key)]),
    );
    for (const e of view.entities) {
      for (const f of fieldsBySchema.get(e.spine.replace(/s$/, "")) ?? []) {
        fillable.add(`${e.spine}.${e.id}.${f}`);
      }
    }
  }

  const offerLines = economics.offers.map((o) =>
    [
      `OFFER ${o.offer_id}`,
      `name=${o.name}`,
      `price=${o.price.amount_minor / 100} ${o.price.currency}`,
      o.cost_to_deliver
        ? `cost=${o.cost_to_deliver.amount_minor / 100} ${o.cost_to_deliver.currency}`
        : `cost=UNKNOWN (fillable: offers.${o.offer_id}.cost_to_deliver)`,
      o.volume !== null
        ? `volume=${o.volume}/month`
        : `volume=UNKNOWN (fillable: offers.${o.offer_id}.volume_period)`,
      o.margin_pct ? `margin=${o.margin_pct.value}%` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  const user = [
    `FINDINGS (address by index):`,
    ...args.findings.map(
      (f, i) => `${i}. [${f.severity}] ${f.title} — ${f.detail} (evidence: ${f.evidence.join(", ")})`,
    ),
    "",
    `OFFERS (price changes may only target rows with both cost and volume):`,
    ...(offerLines.length > 0 ? offerLines : ["(none with a price)"]),
    "",
    `FIELD KEYS THAT EXIST (close_gap may only cite these):`,
    [...view.facts.keys()].sort().join(", "),
  ].join("\n");

  const llm = args.llm ?? liveRecommendationsLlm;
  const { text, calls } = await llm({ system: SYSTEM, user, accountId: args.accountId });

  let payload: { recommendations?: unknown };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new DiagnosisError(`recommendations returned non-JSON: ${text.slice(0, 160)}`);
  }

  const { kept, rejected } = buildRecommendations(
    payload.recommendations,
    args.findings.length,
    offersById,
    fillable,
  );
  if (kept.length === 0) {
    throw new DiagnosisError(
      `every recommendation was rejected (${rejected.map((r) => r.reason).join(" | ")})`,
    );
  }

  return {
    snapshot_id: summary.id,
    recommendations: kept,
    rejected,
    calls,
    cost_eur: calls.reduce((sum, c) => sum + c.cost_eur, 0),
  };
}
