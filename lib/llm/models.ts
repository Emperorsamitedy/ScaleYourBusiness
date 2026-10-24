// Which Sonnet and which Opus — the one place the choice is read (M-2 prep).
//
// Two environment switches, each with exactly two accepted values. Unset
// (or empty) means today's models, byte for byte: claude-sonnet-5 for the
// interviewer and every Sonnet answer, claude-opus-4-8 for the diagnosis,
// the recommendations and the care review. Moving either switch is a
// deliberate step taken AFTER `npm run recalibrate:diagnosis` has compared
// the two models on the real businesses — never a default.
//
//   SONNET_MODEL     claude-sonnet-5 (default) | claude-sonnet-5-5
//   DIAGNOSIS_MODEL  claude-opus-4-8 (default) | claude-opus-5-5
//
// A value outside those throws at the call: a typo must never quietly run
// a model nobody chose (or silently fall back to one).
//
// The 5.5 models reject parts of today's requests, so each call site asks
// this file for its request shape instead of hard-coding one:
//   · Sonnet 5.5: thinking {type:"disabled"} is a 400 — the lowest setting
//     is {type:"between_tools"}, accepted only at effort high or below and
//     with no other field inside `thinking`. Forced tool_choice is a 400.
//   · Opus 5.5: thinking cannot be disabled; effort is the only control
//     and DEFAULTS TO MEDIUM (Opus 4.8 runs at high), so it is always sent.
//   · Both: no non-default sampling parameters, no assistant prefill (no
//     call here sends either — the site tests prove it), and a refusal can
//     arrive as HTTP 200 with stop_reason "refusal" (lib/llm/answer.ts).

import type Anthropic from "@anthropic-ai/sdk";

export const SONNET_5 = "claude-sonnet-5";
export const SONNET_5_5 = "claude-sonnet-5-5";
export const OPUS_4_8 = "claude-opus-4-8";
export const OPUS_5_5 = "claude-opus-5-5";

export const SONNET_MODELS = [SONNET_5, SONNET_5_5] as const;
export type SonnetModel = (typeof SONNET_MODELS)[number];
export const DIAGNOSIS_MODELS = [OPUS_4_8, OPUS_5_5] as const;
export type DiagnosisModel = (typeof DIAGNOSIS_MODELS)[number];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type Env = Readonly<Record<string, string | undefined>>;

export class ModelSettingError extends Error {
  constructor(name: string, value: string, allowed: readonly string[]) {
    super(`${name}="${value}" is not a model this app can run — use one of: ${allowed.join(", ")}`);
    this.name = "ModelSettingError";
  }
}

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T, env: Env): T {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ModelSettingError(name, raw, allowed);
}

/** The Sonnet every Sonnet call site uses. Read per call, so a test can flip it. */
export function sonnetModel(env: Env = process.env): SonnetModel {
  return pick("SONNET_MODEL", SONNET_MODELS, SONNET_5, env);
}

/** The Opus behind the diagnosis, the recommendations and the care review. */
export function diagnosisModel(env: Env = process.env): DiagnosisModel {
  return pick("DIAGNOSIS_MODEL", DIAGNOSIS_MODELS, OPUS_4_8, env);
}

/* ── Sonnet request shapes ── */

/**
 * The interviewer's "no thinking": {type:"disabled"} on Sonnet 5, exactly as
 * today; {type:"between_tools"} on Sonnet 5.5, where "disabled" is a 400.
 * The interviewer's effort is "low", inside between_tools' high-or-below
 * limit. SDK 0.120's types predate between_tools, hence the cast; the API
 * reads the JSON, not the type.
 */
export function thinkingOff(model: SonnetModel): Anthropic.ThinkingConfigParam {
  if (model === SONNET_5_5) {
    return { type: "between_tools" } as unknown as Anthropic.ThinkingConfigParam;
  }
  return { type: "disabled" };
}

/** The Sonnet sites that answer or draft, as opposed to the interviewer's pick. */
export type SonnetAnswerSite = "chat" | "content" | "support_answer" | "support_draft";

/**
 * What a Sonnet answer site sends on Sonnet 5.5 — today's Sonnet 5 requests
 * send no thinking field and no effort, and keep doing so.
 *
 * Effort "low": Sonnet 5.5's levels are recalibrated, so carrying the
 * implicit "high" over would be a guess; the migration guide's starting
 * point for chat, content generation and support answers is "low", where
 * the model skips thinking on most simple requests. Thinking still counts
 * toward max_tokens, so each cap gets room for it (today's caps were sized
 * for answers alone: 400 / 900 / 400 / 700). The support caps stay inside
 * SUPPORT_MESSAGE_RESERVE_EUR: 1,200 output tokens at $10/MTok is ~€0.011.
 */
export const SONNET_5_5_ANSWER: Readonly<
  Record<SonnetAnswerSite, { effort: Effort; max_tokens: number }>
> = {
  chat: { effort: "low", max_tokens: 1_200 },
  content: { effort: "low", max_tokens: 2_000 },
  support_answer: { effort: "low", max_tokens: 1_200 },
  support_draft: { effort: "low", max_tokens: 1_600 },
};

/**
 * One Sonnet answer site's model, max_tokens and the effort to merge into
 * output_config. On Sonnet 5 the effort is absent and max_tokens is
 * today's, so the request is exactly what it was.
 */
export function sonnetAnswerShape(
  site: SonnetAnswerSite,
  todayMaxTokens: number,
  model: SonnetModel = sonnetModel(),
): { model: SonnetModel; max_tokens: number; effort: { effort: Effort } | Record<string, never> } {
  if (model !== SONNET_5_5) return { model, max_tokens: todayMaxTokens, effort: {} };
  const shape = SONNET_5_5_ANSWER[site];
  return { model, max_tokens: shape.max_tokens, effort: { effort: shape.effort } };
}

/* ── Opus request shapes ── */

/**
 * Opus 5.5's effort for the diagnosis, the recommendations and the care
 * review: "high". These are the product's judgement calls — the one place
 * the system weighs a business — and they run a handful of times per
 * business, so depth is worth more than the tokens. "medium" is Opus 5.5's
 * API default and Anthropic measured it above Opus 5 at "high" on
 * knowledge work, so the recalibration run may show "medium" is enough;
 * that is a measured decision to make with its numbers, not up front.
 * "xhigh"/"max" are reserved for a measured gain.
 */
export const OPUS_5_5_EFFORT: Effort = "high";

/**
 * Opus 5.5 tends to think more per turn than earlier Opus at the same
 * effort, and thinking counts toward max_tokens: the 5.5 path doubles each
 * site's cap so the JSON is not cut off behind the thinking.
 */
export const OPUS_5_5_MAX_TOKENS_FACTOR = 2;

/**
 * One Opus site's request shape. Thinking is adaptive on both models (as
 * today on 4.8; on 5.5 it cannot be anything else). On Opus 4.8 nothing
 * else changes — no effort is sent, max_tokens is today's.
 */
export function opusShape(
  todayMaxTokens: number,
  model: DiagnosisModel = diagnosisModel(),
): {
  model: DiagnosisModel;
  max_tokens: number;
  thinking: { type: "adaptive" };
  effort: { effort: Effort } | Record<string, never>;
} {
  if (model !== OPUS_5_5) {
    return { model, max_tokens: todayMaxTokens, thinking: { type: "adaptive" }, effort: {} };
  }
  return {
    model,
    max_tokens: todayMaxTokens * OPUS_5_5_MAX_TOKENS_FACTOR,
    thinking: { type: "adaptive" },
    effort: { effort: OPUS_5_5_EFFORT },
  };
}
