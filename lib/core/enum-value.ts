// EnumValue — data-model-v1.md §3.4, the enum with an escape hatch.
//
// Every selectable list gets a controlled vocabulary plus "other". When the
// owner picks "other", label_raw preserves their exact wording — that text
// is what the recurring-others report (Session F) mines to promote popular
// answers into the vocabulary, so it is load-bearing, not cosmetic.
//
// Membership of `code` in a specific vocabulary is checked where the
// vocabulary is known (the bank loader, Session H) — this module only
// enforces the shape rules that hold for every vocabulary.

export const OTHER_CODE = "other";

export interface EnumValue {
  /** A code from a controlled vocabulary, or OTHER_CODE. */
  code: string;
  /** The owner's exact wording — present only when code is "other". */
  label_raw?: string;
}

export class InvalidEnumValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnumValueError";
  }
}

/**
 * Validating constructor. label_raw travels only with "other": attached to
 * a real vocabulary code it would shadow the vocabulary's own label and
 * corrupt the recurring-others report.
 */
export function enumValue(code: string, label_raw?: string): EnumValue {
  if (code.trim() === "") {
    throw new InvalidEnumValueError("code must not be empty");
  }
  if (label_raw !== undefined && code !== OTHER_CODE) {
    throw new InvalidEnumValueError(
      `label_raw is only for "${OTHER_CODE}" values — "${code}" is a vocabulary code and carries its own label`,
    );
  }
  if (label_raw !== undefined && label_raw.trim() === "") {
    throw new InvalidEnumValueError(
      "an empty label_raw records nothing — omit it, or preserve what the owner actually typed",
    );
  }
  return label_raw === undefined ? { code } : { code, label_raw };
}

export function isOther(value: EnumValue): boolean {
  return value.code === OTHER_CODE;
}
