// Bank loader — §6.1 / step 18.
//
// One atomic load per bank version: lint gate first (P0-38 — the loader
// refuses what scripts/lint_bank.py refuses, one linter, one truth), then
// questions + entity schemas inserted UNDER their version while previous
// versions' rows stay untouched (P0-37 — answers recorded against an old
// version keep their question provenance), vocabularies mirrored to the
// current bank, and the is_current pointer moved last.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { bankEntitySchemas, bankQuestions, bankVersions } from "../../db/schema";
import type { ProfileSection } from "../profile/sections";
import { isProfileSection, sectionOfFieldKey } from "../profile/sections";
import { loadVocabularies } from "../vocab/loader";

export class BankLintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankLintError";
  }
}

export class BankLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankLoadError";
  }
}

interface BankQuestionJson {
  id: string;
  version: number;
  section: string;
  writes_to: string;
  prompt: Record<string, string>;
  help_text?: Record<string, string>;
  input: Record<string, unknown>;
  condition: unknown;
  priority: "core" | "important" | "deep" | "optional";
  cost: number;
  unlocks?: string[];
}

interface BankJson {
  bank_version: string;
  vocabularies: Record<string, string[]>;
  entity_schemas: Record<
    string,
    { label: Record<string, string>; min_items?: number; fields: unknown[] }
  >;
  questions: BankQuestionJson[];
}

/** Bank flow-section names map onto profile sections; one differs. */
const BANK_SECTION_TO_PROFILE: Readonly<Record<string, ProfileSection>> = {
  competition: "competitors",
};

function profileSectionOf(bankSection: string): ProfileSection {
  const mapped = BANK_SECTION_TO_PROFILE[bankSection];
  if (mapped) return mapped;
  if (isProfileSection(bankSection)) return bankSection;
  throw new BankLoadError(`question section "${bankSection}" maps to no profile section`);
}

// CI and macOS have "python3"; a default Windows install has only
// "python" (and a "python3" App Execution Alias that opens the Microsoft
// Store instead of running anything). Probing keeps one linter as the
// single truth while letting the loader run on a Windows dev machine.
// PYTHON overrides both, for a venv or a non-PATH interpreter.
let cachedPython: string | null = null;

export function pythonCommand(): string {
  if (cachedPython) return cachedPython;
  const override = process.env.PYTHON;
  const candidates = override ? [override] : ["python3", "python", "py"];
  for (const candidate of candidates) {
    try {
      // The Store alias exits non-zero with no stdout, so a real version
      // string is the test — not merely "the call did not throw".
      const out = execFileSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out.trim() === "3") {
        cachedPython = candidate;
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new BankLintError(
    `no Python 3 interpreter found (tried ${candidates.join(", ")}) — ` +
      `scripts/lint_bank.py gates every bank load. Install Python 3 or set PYTHON.`,
  );
}

/** P0-38 — run the canonical linter; throw its output when it refuses. */
export function lintBank(path: string): void {
  try {
    execFileSync(pythonCommand(), ["scripts/lint_bank.py", path], { encoding: "utf8" });
  } catch (error) {
    if (error instanceof BankLintError) throw error;
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new BankLintError(
      `bank failed lint, refusing to load:\n${e.stdout ?? ""}${e.stderr ?? e.message}`,
    );
  }
}

export interface BankLoadResult {
  bank_version: string;
  questions: number;
  vocabularies: number;
  entity_schemas: number;
}

/** Lint, then load a bank file atomically and point is_current at it. */
export async function loadBank(path: string): Promise<BankLoadResult> {
  lintBank(path);

  const raw = readFileSync(path, "utf8");
  const bank = JSON.parse(raw) as BankJson;
  const version = bank.bank_version;
  if (typeof version !== "string" || version === "") {
    throw new BankLoadError("bank has no bank_version");
  }

  // Every writes_to must land in a known section — the storage-side check
  // that keeps the bank and the profile's key space in one universe.
  for (const q of bank.questions) {
    sectionOfFieldKey(q.writes_to);
  }

  await db.transaction(async (tx) => {
    // Idempotent per version: reloading replaces this version's rows only.
    await tx.delete(bankQuestions).where(eq(bankQuestions.bank_version, version));
    await tx.delete(bankEntitySchemas).where(eq(bankEntitySchemas.bank_version, version));
    await tx.delete(bankVersions).where(eq(bankVersions.version, version));

    await tx.insert(bankVersions).values({
      version,
      source_hash: createHash("sha256").update(raw).digest("hex"),
      question_count: bank.questions.length,
      vocabulary_count: Object.keys(bank.vocabularies).length,
      entity_schema_count: Object.keys(bank.entity_schemas).length,
    });

    await tx.insert(bankQuestions).values(
      bank.questions.map((q) => ({
        bank_version: version,
        id: q.id,
        question_version: q.version,
        section: profileSectionOf(q.section),
        writes_to: q.writes_to,
        prompt: q.prompt,
        help_text: q.help_text ?? null,
        input: q.input,
        condition: q.condition ?? null,
        priority: q.priority,
        cost: q.cost,
        unlocks: q.unlocks ?? null,
      })),
    );

    await tx.insert(bankEntitySchemas).values(
      Object.entries(bank.entity_schemas).map(([key, schema]) => ({
        bank_version: version,
        key,
        label: schema.label,
        min_items: schema.min_items ?? null,
        fields: schema.fields,
      })),
    );

    // Vocabularies mirror the loading bank (Session F semantics).
    await loadVocabularies({ bank_version: version, vocabularies: bank.vocabularies }, tx);

    // Move the pointer last — everything above must have succeeded.
    await tx
      .update(bankVersions)
      .set({ is_current: false })
      .where(ne(bankVersions.version, version));
    await tx
      .update(bankVersions)
      .set({ is_current: true })
      .where(eq(bankVersions.version, version));
  });

  return {
    bank_version: version,
    questions: bank.questions.length,
    vocabularies: Object.keys(bank.vocabularies).length,
    entity_schemas: Object.keys(bank.entity_schemas).length,
  };
}
