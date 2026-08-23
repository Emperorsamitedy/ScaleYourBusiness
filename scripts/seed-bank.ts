// Seed the question bank + vocabularies into whatever DATABASE_URL points
// at (P0-85 prep). Run from a dev machine — the bank loader shells out to
// scripts/lint_bank.py (the one linter, one truth), which serverless
// hosts can't do. Staging flow: point DATABASE_URL at Neon, run
// `npm run db:migrate && npm run db:seed`, flip DATABASE_URL back.

import "dotenv/config";
import { loadBank } from "../lib/bank/loader";
import { loadVocabularies, readBankVocabularies } from "../lib/vocab/loader";

const BANK = "specs/question-bank-v1.json";

async function main(): Promise<void> {
  const vocab = await loadVocabularies(readBankVocabularies(BANK));
  console.log(`vocabularies: ${JSON.stringify(vocab)}`);
  const bank = await loadBank(BANK);
  console.log(`bank: ${JSON.stringify(bank)}`);
  process.exit(0);
}

void main();
