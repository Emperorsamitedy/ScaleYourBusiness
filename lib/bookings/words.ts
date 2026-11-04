// The bookings sentences SYB builds from numbers — L-4c of TASKS-LANGUAGES.md.
// Every measure's arithmetic, every reason a measure isn't measured, and
// every refusal of an import come from the "connectionsWords" catalogue
// (messages/*.json): English by default, so what is stored on a fact (its
// method, a refusal's reason) is exactly what the code said before L-4, and
// the request's language when the Connections screen asks (app/api/bookings).
// Pure, and safe anywhere.

import { dayMonthYear, intlNumber } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

/** The namespace of every server-built sentence on /connections. */
export const CONNECTIONS_WORDS = "connectionsWords";

/** A translator and the language it writes. */
export interface Say {
  tr: Tr;
  locale: AppLocale;
}

/** English, from messages/en.json — what the code always said. */
export const englishSay = (): Say => ({ tr: englishTr(CONNECTIONS_WORDS), locale: "en" });

/** A stored day ("2026-10-17"): as stored in English, as before; the language's date elsewhere. */
export function dayWords(iso: string, locale: AppLocale): string {
  return locale === "en" ? iso : dayMonthYear(iso.slice(0, 10), locale);
}

/** A figure as the code wrote it (String(n)): English as before, another language its own digits. */
export function plain(n: number, locale: AppLocale): string {
  if (locale === "en") return String(n);
  const decimals = Number.isInteger(n) ? 0 : Math.min(String(n).split(".")[1]?.length ?? 0, 3);
  return intlNumber(n, decimals, locale);
}

/** "EUR and HUF": English joined as before, another language's own "and". */
export function andList(items: readonly string[], locale: AppLocale): string {
  if (locale === "en") return items.join(" and ");
  return new Intl.ListFormat(intlTag(locale), { style: "long", type: "conjunction" }).format(items);
}

/* ── the import's refusals ── */

/** A refusal's catalogue key under "bookings.refuse", and the values it needs. */
export interface RefusalWords {
  key: string;
  values?: Record<string, string | number>;
  /** "none of the rows could be read": the counts per reason, said in the reader's words. */
  skipped?: Partial<Record<string, number>>;
}

/** The sample figures the refusals show, typed once (rule 3). */
export const REFUSAL_SAMPLES = {
  dmyExample: "13/01",
  mdyExample: "01/13",
  slashDate: "03/04/2026",
  slashDmy: "2026-04-03",
  slashMdy: "2026-03-04",
  currencyExample: "EUR",
  ambiguousAmount: "1.200",
  commaDecimal: "1.234,56",
  dotDecimal: "1,234.56",
} as const;

/** "3 April" / "4 March": a day of 03/04/2026 read one way, as the English always said. */
function readingOf(day: string, locale: AppLocale): string {
  if (locale === "en") return day === REFUSAL_SAMPLES.slashDmy ? "3 April" : "4 March";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** The values every refusal may use, in the reader's writing. */
function refusalValues(locale: AppLocale): Record<string, string> {
  return {
    dmy: REFUSAL_SAMPLES.dmyExample,
    mdy: REFUSAL_SAMPLES.mdyExample,
    sample: REFUSAL_SAMPLES.slashDate,
    asDmy: readingOf(REFUSAL_SAMPLES.slashDmy, locale),
    asMdy: readingOf(REFUSAL_SAMPLES.slashMdy, locale),
    example: REFUSAL_SAMPLES.currencyExample,
    amount: REFUSAL_SAMPLES.ambiguousAmount,
    comma: REFUSAL_SAMPLES.commaDecimal,
    dot: REFUSAL_SAMPLES.dotDecimal,
  };
}

/** Pure: one refusal in the reader's language (English: exactly the code's old sentence). */
export function sayRefusal(words: RefusalWords, say: Say = englishSay()): string {
  const { tr, locale } = say;
  const values: Record<string, string | number> = { ...refusalValues(locale) };
  for (const [k, v] of Object.entries(words.values ?? {})) {
    values[k] = typeof v === "number" ? plain(v, locale) : v;
  }
  let key = words.key;
  if (words.skipped !== undefined) {
    const reasons = Object.entries(words.skipped)
      .filter((e): e is [string, number] => e[1] !== undefined)
      .map(([reason, count]) =>
        tr("bookings.refuse.skipItem", {
          count: plain(count, locale),
          reason: SKIP_WORDS.has(reason)
            ? tr(`bookings.refuse.skip.${reason}`)
            : reason.replace(/_/g, " "),
        }),
      )
      .join(tr("bookings.refuse.listSep"));
    if (reasons !== "") {
      values["reasons"] = reasons;
      key = `${key}Why`;
    }
  }
  return tr(`bookings.refuse.${key}`, values);
}

/** The row-skip reasons the catalogue words (lib/bookings/rows ROW_SKIP_REASONS). */
const SKIP_WORDS: ReadonlySet<string> = new Set([
  "no_date",
  "unreadable_date",
  "no_status",
  "unknown_status",
  "not_closed_out",
]);
