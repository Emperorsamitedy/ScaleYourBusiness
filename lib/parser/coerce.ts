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

export type CoerceResult = { ok: true; value: unknown } | { ok: false; reason: string };

const fail = (reason: string): CoerceResult => ({ ok: false, reason });

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
      if (typeof wire !== "string" || wire.trim() === "") return fail("expected non-empty text");
      return { ok: true, value: wire.trim() };
    }
    case "number": {
      if (typeof wire !== "number" || !Number.isFinite(wire)) return fail("expected finite number");
      // The bank's own bounds (review 2026-10-23, #13): "4000" is not a share
      // of customers, whichever channel it came through.
      if (typeof spec.min === "number" && wire < spec.min) {
        return fail(`must be at least ${spec.min}`);
      }
      if (typeof spec.max === "number" && wire > spec.max) {
        return fail(`must be at most ${spec.max}`);
      }
      return { ok: true, value: wire };
    }
    case "money": {
      if (wire === null || typeof wire !== "object")
        return fail("expected {amount_major, currency?}");
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
      if (!parts) return fail("money needs a finite amount_major");
      const currency =
        typeof w.currency === "string" && w.currency.trim() !== ""
          ? w.currency.trim().toUpperCase()
          : reportingCurrency;
      if (!isIsoCurrency(currency)) return fail(`"${currency}" is not an ISO 4217 currency`);
      const exact = digitsToMinor(parts[1] === "-", parts[2] ?? "", parts[3] ?? "", currency);
      if (!exact.ok) {
        return fail(
          exact.reason === "too_precise"
            ? `more precise than ${currency} allows`
            : "too large to hold exactly",
        );
      }
      const minor = exact.minor;
      try {
        return { ok: true, value: money(minor, currency) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid money");
      }
    }
    case "boolean": {
      if (typeof wire !== "boolean") return fail("expected boolean");
      return { ok: true, value: wire };
    }
    case "date": {
      if (typeof wire !== "string") return fail("expected ISO date string");
      try {
        return { ok: true, value: isoDate(wire) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid date");
      }
    }
    case "single_select": {
      if (typeof wire !== "string") return fail("expected a vocabulary code");
      if (!vocabCodes.includes(wire)) return fail(`"${wire}" is not in the vocabulary`);
      try {
        return { ok: true, value: enumValue(wire) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid code");
      }
    }
    case "multi_select": {
      if (!Array.isArray(wire) || wire.length === 0) return fail("expected a non-empty code array");
      const values = [];
      for (const item of wire) {
        if (typeof item !== "string") return fail("codes must be strings");
        if (!vocabCodes.includes(item)) return fail(`"${item}" is not in the vocabulary`);
        values.push(enumValue(item));
      }
      return { ok: true, value: values };
    }
    case "entity_list":
    case "file":
      // Entity rows and uploads come from dedicated UI controls, not from
      // free-text parsing. The parser must never fabricate entities.
      return fail(`input type "${spec.type}" is not parseable from free text`);
  }
}
