// L-4c: the support desk's owner-facing server sentences — refusals, the
// draft refusal, a send's outcome note, a knowledge proposal's summary — are
// said in the reader's language from the "supportWords" catalogue, but only
// when SYB's own English reproduces them byte for byte. English is the code's
// own words (pinned here, and scanned from every throw site); a sentence that
// isn't SYB's — the email service's message, the owner's question — is shown
// as it came.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { CANT_DRAFT } from "./draft";
import { MAYBE_SENT, NOT_SET_UP, STOPPED } from "./replies";
import {
  draftRefusalWords,
  knowledgeSummaryWords,
  outcomeNoteWords,
  supportEnglish,
  supportErrorWords,
} from "./words";

const EN = supportEnglish();

const lang = (locale: AppLocale): Tr => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
  const t = createTranslator({
    locale,
    messages,
    namespace: "supportWords" as "common",
    timeZone: "UTC",
  }) as unknown as Tr;
  return (k, v) => t(k, v);
};
const de = lang("de-DE");
const ru = lang("ru-RU");
const zh = lang("zh-Hans");

/** Every refusal literal thrown by the classes /api/support answers with, `${…}` read as 7. */
function thrown(): string[] {
  const files = [
    "lib/crm/knowledge.ts",
    "lib/crm/support-settings.ts",
    "lib/crm/faq.ts",
    "lib/support/tickets.ts",
    "lib/support-desk/draft.ts",
    "lib/support-desk/replies.ts",
  ];
  const out: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    for (const m of src.matchAll(
      /new (?:KnowledgeError|SupportSettingsError|FaqError|TicketError|ReplyError)\(\s*(["`])((?:\\.|(?!\1)[\s\S])*)\1/g,
    )) {
      out.push((m[2] as string).replace(/\$\{[^}]*\}/g, "7"));
    }
  }
  return out;
}

describe("English is what the desk always said", () => {
  it("holds the draft refusal and the send notes to the code's constants", () => {
    expect(EN("draft.cant")).toBe(CANT_DRAFT);
    expect(EN("note.notSetUp")).toBe(NOT_SET_UP);
    expect(EN("note.stopped")).toBe(STOPPED);
    expect(EN("note.maybeSent")).toBe(MAYBE_SENT);
    expect(EN("draft.budget", { budget: "€5" })).toBe(
      "This month's support budget (€5) is spent, so I won't draft — write it yourself.",
    );
    expect(EN("summary.facts", { count: 1, n: "1" })).toBe(
      "Publish 1 answer the customer assistant may give",
    );
    expect(EN("summary.faq", { count: 3, n: "3" })).toBe(
      "Publish 3 answers customers keep asking for, in your own words",
    );
  });

  it("knows every refusal those classes throw, word for word", () => {
    const literals = thrown();
    expect(literals.length).toBeGreaterThan(25);
    for (const l of literals) expect(supportErrorWords(l, de, "de-DE"), l).not.toBe(l);
    for (const l of ["no such conversation", "no such ticket"]) {
      expect(supportErrorWords(l, de, "de-DE")).not.toBe(l);
    }
    expect(supportErrorWords("no such ticket", EN, "en")).toBe("no such ticket");
  });

  it("leaves English rows, and any sentence that isn't ScaleX's, as they came", () => {
    const service =
      "Not sent: the email service refused it (422: invalid from). Nothing went out — write it again to retry.";
    expect(outcomeNoteWords(service, EN, "en")).toBe(service);
    expect(outcomeNoteWords(null, de, "de-DE")).toBeNull();
    expect(outcomeNoteWords("Something the email service said.", de, "de-DE")).toBe(
      "Something the email service said.",
    );
    expect(knowledgeSummaryWords("Publish what I wrote", de, "de-DE")).toBe("Publish what I wrote");
    // A count that doesn't reproduce the English (here "answers" at one) stays as stored.
    expect(
      knowledgeSummaryWords("Publish 1 answers the customer assistant may give", de, "de-DE"),
    ).toBe("Publish 1 answers the customer assistant may give");
  });
});

describe("in the reader's language", () => {
  it("says notes, the draft refusal and a summary in German, keeping what isn't ScaleX's", () => {
    const service =
      "Not sent: the email service refused it (422: invalid from). Nothing went out — write it again to retry.";
    const said = outcomeNoteWords(service, de, "de-DE")!;
    expect(said).not.toBe(service);
    expect(said).toContain("422: invalid from");
    const gate = outcomeNoteWords(
      "Not sent: the gate refused it — suppressed (unsubscribed).",
      de,
      "de-DE",
    )!;
    expect(gate).toContain("unsubscribed");
    expect(gate).not.toContain("Not sent");
    const budget = draftRefusalWords(
      "This month's support budget (€5) is spent, so I won't draft — write it yourself.",
      de,
      "de-DE",
    );
    expect(budget).toContain("5 €");
    const custom = knowledgeSummaryWords(
      'Publish an answer you wrote: "Do you ship?"',
      de,
      "de-DE",
    );
    expect(custom).toContain("Do you ship?");
    expect(custom).not.toContain("Publish");
    expect(supportErrorWords("keep a reply under 4000 characters", de, "de-DE")).toContain("4.000");
  });

  it("gives Russian its counting forms at 1, 3, 5 and 21", () => {
    const say = (n: number) =>
      knowledgeSummaryWords(EN("summary.facts", { count: n, n: String(n) }), ru, "ru-RU");
    const [one, few, many, twentyOne] = [1, 3, 5, 21].map(say);
    expect(one!.replace("1", "#")).toBe(twentyOne!.replace("21", "#"));
    expect(few!.replace("3", "#")).not.toBe(many!.replace("5", "#"));
    expect(one!.replace("1", "#")).not.toBe(many!.replace("5", "#"));
    const times = (n: number) =>
      draftRefusalWords(
        `I've drafted this ticket ${n} times already — write this one yourself.`,
        ru,
        "ru-RU",
      );
    expect(times(3)).toContain("3");
    expect(times(3)).not.toContain("drafted");
  });

  it("writes Chinese with full-width punctuation and no space after it", () => {
    const said = outcomeNoteWords(NOT_SET_UP, zh, "zh-Hans")!;
    expect(said).not.toBe(NOT_SET_UP);
    expect(said).toMatch(/。$/);
    expect(said).not.toMatch(/[。，；：] /);
    const stopped = outcomeNoteWords(STOPPED, zh, "zh-Hans")!;
    expect(stopped).not.toMatch(/[。，；：] /);
  });
});
