// English words for vocabulary codes whose humanised form reads badly —
// specs/vocabulary-labels-en.json. "salon_beauty" reads "Hair or beauty
// salon", "tiktok" reads "TikTok". The code stays the answer (rule 4 of
// the data model: values are codes); only the words shown change. The
// other languages carry every code in their overlays.

import file from "../../specs/vocabulary-labels-en.json";

const LABELS = (file as { labels: Record<string, Record<string, string>> }).labels;

/** The English words for a vocabulary code, or undefined when its humanised form is fine. */
export function englishLabel(vocabularyId: string, code: string): string | undefined {
  return LABELS[vocabularyId]?.[code];
}

/** Every listed label, for the spec's own test. */
export function englishLabels(): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return LABELS;
}
