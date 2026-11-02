// GET /api/profile — the fact sheet (P1-59/60): every captured fact
// with its source, from the snapshot, plus the gaps and what answering
// each would buy. Session-scoped like the intake; read-only.

import { logSafeError } from "../../../lib/core/log-safe";
import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { buildFactSheet } from "../../../lib/profile/factsheet";
import { entityTextValue, factWords } from "../../../lib/bank/fact-words";
import { loadBankWords } from "../../../lib/bank/words";
import { requestLocale } from "../../../lib/i18n/server";

type Sheet = Awaited<ReturnType<typeof buildFactSheet>>;

/**
 * L-3a: the sheet's labels, coded values and open questions in the
 * reader's language, from the bank's overlay (lib/bank/fact-words). The
 * values stay as recorded (rule 4); an English sheet is unchanged.
 */
async function inLanguage(sheet: Sheet): Promise<Sheet> {
  const locale = await requestLocale();
  if (locale === "en") return sheet;
  const words = await loadBankWords(locale);
  const fw = factWords(words);
  return {
    ...sheet,
    sections: sheet.sections.map((s) => ({
      ...s,
      facts: s.facts.map((f) => ({
        ...f,
        label: fw.label(f.key),
        value_words: fw.textValue(f.key, f.value),
      })),
    })),
    entities: sheet.entities.map((g) => ({
      ...g,
      facts: g.facts.map((f) => ({
        ...f,
        label: fw.field(g.spine, f.key),
        value_words: entityTextValue(fw, g.spine, f.key, f.value),
      })),
    })),
    gaps: sheet.gaps.map((g) => ({ ...g, prompt: words.prompt(g.question_id, g.prompt) })),
  };
}

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  try {
    return NextResponse.json(await inLanguage(await buildFactSheet(row.id)));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "factsheet_error",
        account_id: row.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
