// Vocabulary membership validation — §3.4 / step 16 (P0-31).
//
// enum-value.ts enforces the shape rules that hold for every vocabulary
// (label_raw only with "other", never empty). This module adds the rule
// that needs the vocabulary itself: the code must be one of its entries.
// 38 of the 55 bank vocabularies are closed lists with no "other" — for
// those, an "other" answer is a mis-capture, not an escape hatch.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { vocabularyEntries } from "../../db/schema";
import type { EnumValue } from "../core/enum-value";
import { OTHER_CODE } from "../core/enum-value";

export class VocabularyMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyMembershipError";
  }
}

/** Fetch a vocabulary's codes in bank order. Empty array = unknown vocabulary. */
export async function vocabularyCodes(vocabKey: string): Promise<string[]> {
  const rows = await db
    .select({ code: vocabularyEntries.code, position: vocabularyEntries.position })
    .from(vocabularyEntries)
    .where(eq(vocabularyEntries.vocab_key, vocabKey))
    .orderBy(vocabularyEntries.position);
  return rows.map((r) => r.code);
}

/**
 * Validate an EnumValue against a vocabulary's entries (pure — callers
 * fetch entries once per question, not once per value).
 */
export function validateAgainstVocabulary(
  vocabKey: string,
  entries: readonly string[],
  value: EnumValue,
): EnumValue {
  if (entries.length === 0) {
    throw new VocabularyMembershipError(`vocabulary "${vocabKey}" is unknown or empty`);
  }
  if (!entries.includes(value.code)) {
    throw new VocabularyMembershipError(
      value.code === OTHER_CODE
        ? `vocabulary "${vocabKey}" is a closed list — "other" is not an entry, so free-text answers are mis-captures here`
        : `"${value.code}" is not in vocabulary "${vocabKey}"`,
    );
  }
  return value;
}
