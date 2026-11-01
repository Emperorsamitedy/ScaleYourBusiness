// Parsed-answer coercion — the deterministic half of the parser (P0-54).
//
// Haiku extracts; THIS layer decides what enters the profile. The model
// returns neutral wire values (numbers as numbers, money as major units +
// currency, selects as codes); coercion converts them to the data layer's
// types and refuses anything malformed — a wrong code, a float where
// minor units belong, a date that doesn't exist. The LLM never writes to
// the database; only values that survive this layer do.

import { enumValue } from "../core/enum-value";
import { digitsToMinor, isIsoCurrency, money } from "../core/money";
import { isoDate } from "../core/iso";
import type { InputSpec } from "../interviewer/harness/answers";

export type WireValue = unknown;

/**
 * Why a value was refused, as a code a screen can word in the person's
 * language (L-2: the intake's error lines live in messages/*.json); the
 * English `reason` stays for logs and the model-facing paths.
 */
export type CoerceCode =
  | "expected_text"
  | "expected_number"
  | "min"
  | "max"
  | "unreadable_amount"
  | "unknown_currency"
  | "too_precise"
  | "too_large"
  | "expected_boolean"
  | "invalid_date"
  | "unknown_option"
  | "not_parseable";

export type CoerceResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason: string;
      code: CoerceCode;
      /** The figures or names the reason mentions ({limit}, {currency}). */
      values?: Record<string, string | number>;
    };

const fail = (
  reason: string,
  code: CoerceCode,
  values?: Record<string, string | number>,
): CoerceResult => (values ? { ok: false, reason, code, values } : { ok: false, reason, code });

/**
 * Convert one extracted wire value into the typed value for a question's
 * input spec. `vocabCodes` must be the question's vocabulary (empty for
 * non-select types); `reportingCurrency` fills in when the owner names an
 * amount without a currency.
 */
export function coerceParsedValue(
  spec: InputSpec,
  wire: WireValue,
  vocabCodes: readonly string[],
  reportingCurrency: string,
): CoerceResult {
  switch (spec.type) {
    case "text":
    case "long_text": {
      if (typeof wire !== "string" || wire.trim() === "")
        return fail("expected non-empty text", "expected_text");
      return { ok: true, value: wire.trim() };
    }
    case "number": {
      if (typeof wire !== "number" || !Number.isFinite(wire))
        return fail("expected finite number", "expected_number");
      // The bank's own bounds (review 2026-10-23, #13): "4000" is not a share
      // of customers, whichever channel it came through.
      if (typeof spec.min === "number" && wire < spec.min) {
        return fail(`must be at least ${spec.min}`, "min", { limit: spec.min });
      }
      if (typeof spec.max === "number" && wire > spec.max) {
        return fail(`must be at most ${spec.max}`, "max", { limit: spec.max });
      }
      return { ok: true, value: wire };
    }
    case "money": {
      if (wire === null || typeof wire !== "object")
        return fail("expected {amount_major, currency?}", "unreadable_amount");
      const w = wire as { amount_major?: unknown; currency?: unknown };
      // A number from the model, or a canonical decimal string ("12.50") from
      // the chat's own reader — both through the one exact digit path.
      const decimal =
        typeof w.amount_major === "number" && Number.isFinite(w.amount_major)
          ? String(w.amount_major)
          : typeof w.amount_major === "string"
            ? w.amount_major.trim()
            : null;
      const parts = decimal === null ? null : /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal);
      if (!parts) return fail("money needs a finite amount_major", "unreadable_amount");
      const currency =
        typeof w.currency === "string" && w.currency.trim() !== ""
          ? w.currency.trim().toUpperCase()
          : reportingCurrency;
      if (!isIsoCurrency(currency)) {
        return fail(`"${currency}" is not an ISO 4217 currency`, "unknown_currency", { currency });
      }
      const exact = digitsToMinor(parts[1] === "-", parts[2] ?? "", parts[3] ?? "", currency);
      if (!exact.ok) {
        return exact.reason === "too_precise"
          ? fail(`more precise than ${currency} allows`, "too_precise", { currency })
          : fail("too large to hold exactly", "too_large");
      }
      const minor = exact.minor;
      try {
        return { ok: true, value: money(minor, currency) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid money", "unreadable_amount");
      }
    }
    case "boolean": {
      if (typeof wire !== "boolean") return fail("expected boolean", "expected_boolean");
      return { ok: true, value: wire };
    }
    case "date": {
      if (typeof wire !== "string") return fail("expected ISO date string", "invalid_date");
      try {
        return { ok: true, value: isoDate(wire) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid date", "invalid_date");
      }
    }
    case "single_select": {
      if (typeof wire !== "string") return fail("expected a vocabulary code", "unknown_option");
      if (!vocabCodes.includes(wire)) {
        return fail(`"${wire}" is not in the vocabulary`, "unknown_option");
      }
      try {
        return { ok: true, value: enumValue(wire) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid code", "unknown_option");
      }
    }
    case "multi_select": {
      if (!Array.isArray(wire) || wire.length === 0) {
        return fail("expected a non-empty code array", "unknown_option");
      }
      const values = [];
      for (const item of wire) {
        if (typeof item !== "string") return fail("codes must be strings", "unknown_option");
        if (!vocabCodes.includes(item)) {
          return fail(`"${item}" is not in the vocabulary`, "unknown_option");
        }
        values.push(enumValue(item));
      }
      return { ok: true, value: values };
    }
    case "entity_list":
    case "file":
      // Entity rows and uploads come from dedicated UI controls, not from
      // free-text parsing. The parser must never fabricate entities.
      return fail(`input type "${spec.type}" is not parseable from free text`, "not_parseable");
  }
}
