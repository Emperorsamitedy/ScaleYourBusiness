// Vocabulary loader — step 16 (P0-30).
//
// Loads the 55 controlled lists out of the question bank JSON into the
// vocabulary tables, verbatim and transactionally. Replace-then-insert per
// load keeps the database an exact mirror of one bank version — partial
// merges of two versions are how vocabularies drift. Session H's bank
// loader builds on this (and adds the lint gate + version rules).

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { vocabularies, vocabularyEntries } from "../../db/schema";

export interface BankVocabularies {
  bank_version: string;
  vocabularies: Record<string, string[]>;
}

export class VocabularyLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyLoadError";
  }
}

/** Parse just what this module needs out of a bank JSON file. */
export function readBankVocabularies(path: string): BankVocabularies {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    bank_version?: unknown;
    vocabularies?: unknown;
  };
  if (typeof parsed.bank_version !== "string" || parsed.bank_version === "") {
    throw new VocabularyLoadError("bank JSON has no bank_version");
  }
  const vocab = parsed.vocabularies;
  if (vocab === null || typeof vocab !== "object" || Array.isArray(vocab)) {
    throw new VocabularyLoadError("bank JSON has no vocabularies object");
  }
  for (const [key, entries] of Object.entries(vocab)) {
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.some((e) => typeof e !== "string" || e.trim() === "")
    ) {
      throw new VocabularyLoadError(`vocabulary "${key}" is not a non-empty list of codes`);
    }
    if (new Set(entries).size !== entries.length) {
      throw new VocabularyLoadError(`vocabulary "${key}" contains duplicate codes`);
    }
  }
  return {
    bank_version: parsed.bank_version,
    vocabularies: vocab as Record<string, string[]>,
  };
}

/** Load (or reload) every vocabulary from a bank. Returns counts for verification. */
export async function loadVocabularies(
  bank: BankVocabularies,
): Promise<{ vocabularies: number; entries: number }> {
  let entryCount = 0;
  await db.transaction(async (tx) => {
    for (const [key, codes] of Object.entries(bank.vocabularies)) {
      await tx.delete(vocabularyEntries).where(eq(vocabularyEntries.vocab_key, key));
      await tx.delete(vocabularies).where(eq(vocabularies.key, key));
      await tx.insert(vocabularies).values({ key, bank_version: bank.bank_version });
      await tx
        .insert(vocabularyEntries)
        .values(codes.map((code, position) => ({ vocab_key: key, code, position })));
      entryCount += codes.length;
    }
  });
  return { vocabularies: Object.keys(bank.vocabularies).length, entries: entryCount };
}
