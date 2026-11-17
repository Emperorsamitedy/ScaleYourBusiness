// The command palette's arithmetic (docs/DASHBOARD-OVERHAUL.md B1), pure so
// it is tested without a browser: which rows a typed query keeps and in
// what order, and which screens count as recent. Matching ignores case and
// accents, so "cafe" finds "café" and "uber" finds "Überall".

export type PaletteKind = "recent" | "screen" | "action" | "ask";

export interface PaletteItem {
  /** Unique within one list: "screen:/watch", "action:signout", "ask". */
  id: string;
  kind: PaletteKind;
  /** What the row says, in the reader's language. */
  label: string;
  /** A quiet second text: the screen's group. Matched too, after the label. */
  hint?: string;
  /** Where a screen row goes. */
  href?: string;
  /** More text to match on that is not shown (the English name of a screen). */
  keywords?: string;
}

/** The combining marks an accented letter splits into (U+0300 to U+036F), built from their codes so no invisible character sits in this file. */
const MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

/** Lower case with accents folded away. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(MARKS, "").toLowerCase().trim();
}

/**
 * How well `query` fits a row: 3 when the label starts with it, 2 when a
 * word of the label does, 1 when it appears anywhere in the label, the
 * hint or the keywords, 0 when it does not fit. An empty query fits all.
 */
export function score(item: PaletteItem, query: string): number {
  const q = fold(query);
  if (q === "") return 1;
  const label = fold(item.label);
  if (label.startsWith(q)) return 3;
  if (label.split(/[\s\-/&·,.]+/).some((w) => w.startsWith(q))) return 2;
  const rest = fold(`${item.hint ?? ""} ${item.keywords ?? ""}`);
  return label.includes(q) || rest.includes(q) ? 1 : 0;
}

/** The rows a query keeps, best fit first; rows that tie keep their order. */
export function filterItems(
  items: readonly PaletteItem[],
  query: string,
  limit = 50,
): PaletteItem[] {
  return items
    .map((item, i) => ({ item, i, s: score(item, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/** The most recent screens first, each once, `max` at most. */
export function pushRecent(recent: readonly string[], href: string, max = 6): string[] {
  return [href, ...recent.filter((h) => h !== href)].slice(0, max);
}

/**
 * What the palette lists, top to bottom. With nothing typed: the recent
 * screens (never the one already open), the actions, then every screen.
 * With a query: the screens and actions that fit, then, last, the row
 * that hands the words to Lex as a question.
 */
export function paletteRows(args: {
  query: string;
  screens: readonly PaletteItem[];
  actions: readonly PaletteItem[];
  recent: readonly string[];
  current: string;
  ask: (question: string) => PaletteItem;
  maxRecent?: number;
}): PaletteItem[] {
  const q = args.query.trim();
  if (q === "") {
    const byHref = new Map(args.screens.map((s) => [s.href, s] as const));
    const recent = args.recent
      .filter((h) => h !== args.current)
      .map((h) => byHref.get(h))
      .filter((s): s is PaletteItem => s !== undefined)
      .slice(0, args.maxRecent ?? 5)
      .map((s) => ({ ...s, id: `recent:${s.href ?? s.id}`, kind: "recent" as const }));
    return [...recent, ...args.actions, ...args.screens];
  }
  return [...filterItems(args.screens, q), ...filterItems(args.actions, q), args.ask(q)];
}

/** Arrow keys in the list: wraps at both ends; -1 when the list is empty. */
export function moveActive(count: number, active: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  return (active + step + count) % count;
}
