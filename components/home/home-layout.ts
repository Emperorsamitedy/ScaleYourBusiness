// What Home shows, and in what order (docs/DASHBOARD-OVERHAUL.md, the later
// rounds: "A Home the owner can rearrange or trim") — pure. The owner may
// hide or move the cards of "Your numbers today" and hide Lex's activity.
// What needs the owner and Lex's status card are never hidden: a decision
// waiting for a yes must not be out of sight, and the status card says when
// everything is stopped.
//
// The choice is kept in the browser (as the sales period and the folded menu
// are), so it is this browser's and not the business's: another person on the
// team arranges their own.

/** The cards of "Your numbers today", in the order they come by default. */
// 2026-11-23: the live line next, the size of the sales card (the owner: "everything has to move up").
export const NUMBERS_BLOCKS = ["cash", "visitors", "sales", "slips"] as const;
export type NumbersBlock = (typeof NUMBERS_BLOCKS)[number];

/** Everything that can be hidden: the numbers' cards, and Lex's activity with what he made. */
export const HOME_BLOCKS = [...NUMBERS_BLOCKS, "work"] as const;
export type HomeBlock = (typeof HOME_BLOCKS)[number];

export interface HomeLayout {
  /** The numbers' cards, first to last. Always every one of them, hidden or not. */
  order: NumbersBlock[];
  hidden: HomeBlock[];
}

export const DEFAULT_LAYOUT: HomeLayout = { order: [...NUMBERS_BLOCKS], hidden: [] };

/** Where the browser keeps it. */
export const LAYOUT_KEY = "syb.home.layout";

const isNumbers = (v: unknown): v is NumbersBlock =>
  typeof v === "string" && (NUMBERS_BLOCKS as readonly string[]).includes(v);
const isBlock = (v: unknown): v is HomeBlock =>
  typeof v === "string" && (HOME_BLOCKS as readonly string[]).includes(v);

/**
 * Pure: the layout a browser kept, read back. Anything it cannot make sense
 * of is the default. A card it does not know is dropped; a card added since
 * it was kept takes its place at the end, shown.
 */
export function readLayout(raw: string | null | undefined): HomeLayout {
  if (!raw) return DEFAULT_LAYOUT;
  let kept: unknown;
  try {
    kept = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof kept !== "object" || kept === null) return DEFAULT_LAYOUT;
  const { order, hidden } = kept as { order?: unknown; hidden?: unknown };
  const known = Array.isArray(order) ? [...new Set(order.filter(isNumbers))] : [];
  return {
    order: [...known, ...NUMBERS_BLOCKS.filter((b) => !known.includes(b))],
    hidden: Array.isArray(hidden) ? [...new Set(hidden.filter(isBlock))] : [],
  };
}

/** Pure: what the browser keeps. */
export function writeLayout(layout: HomeLayout): string {
  return JSON.stringify({ order: layout.order, hidden: layout.hidden });
}

export const shows = (layout: HomeLayout, block: HomeBlock): boolean =>
  !layout.hidden.includes(block);

/** Pure: a block hidden, or shown again. */
export function toggled(layout: HomeLayout, block: HomeBlock): HomeLayout {
  return {
    ...layout,
    hidden: shows(layout, block)
      ? [...layout.hidden, block]
      : layout.hidden.filter((b) => b !== block),
  };
}

/** Pure: a numbers card moved one place up (-1) or down (1); at an end it stays. */
export function moved(layout: HomeLayout, block: NumbersBlock, by: -1 | 1): HomeLayout {
  const at = layout.order.indexOf(block);
  const to = at + by;
  if (at === -1 || to < 0 || to >= layout.order.length) return layout;
  const order = [...layout.order];
  const other = order[to];
  if (other === undefined) return layout;
  order[to] = block;
  order[at] = other;
  return { ...layout, order };
}

/** Pure: whether nothing has been changed. */
export function isDefault(layout: HomeLayout): boolean {
  return (
    layout.hidden.length === 0 && layout.order.every((block, i) => block === NUMBERS_BLOCKS[i])
  );
}
