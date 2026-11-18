// How the Trust Ladder screen lays its rows out (specs/ux-spec-v1.md
// §3, "The Trust Ladder screen"). Pure: it arranges what /api/ladder returned and decides nothing
// about a station — every raise is still the server's call.

import type { LadderRow } from "../../lib/ladder/overview";
import type { Seg } from "../charts/Viz";

export const STATIONS = [1, 2, 3, 4] as const;

/** The kinds of action a row belongs to, in the order the screen shows them. */
export const GROUPS: readonly { key: string; capabilities: readonly string[] }[] = [
  { key: "posts", capabilities: ["meta_publish", "tiktok_publish"] },
  { key: "ads", capabilities: ["meta_ads", "tiktok_ads", "google_ads"] },
  {
    key: "customers",
    capabilities: ["email_campaign", "followup_email", "google_business_reviews"],
  },
  { key: "suppliers", capabilities: ["purchase_order"] },
];

/** The rows under their groups, in group order; a capability no group names lands in "other". */
export function groupRows<R extends Pick<LadderRow, "capability">>(
  rows: readonly R[],
): { key: string; rows: R[] }[] {
  const out: { key: string; rows: R[] }[] = [];
  const placed = new Set<string>();
  for (const g of GROUPS) {
    const mine = g.capabilities.flatMap((c) => rows.filter((r) => r.capability === c));
    mine.forEach((r) => placed.add(r.capability));
    if (mine.length > 0) out.push({ key: g.key, rows: mine });
  }
  const rest = rows.filter((r) => !placed.has(r.capability));
  if (rest.length > 0) out.push({ key: "other", rows: rest });
  return out;
}

/** How many rows stand on each station, 1 to 4. */
export function stationCounts(rows: readonly Pick<LadderRow, "station">[]): number[] {
  return STATIONS.map((s) => rows.filter((r) => r.station === s).length);
}

/** The highest station any row may reach here; 4 when there are no rows to say otherwise. */
export function highestOpen(rows: readonly Pick<LadderRow, "ceiling">[]): number {
  return rows.length === 0 ? 4 : Math.max(...rows.map((r) => r.ceiling));
}

/**
 * The one ceiling every row shares when it is below the top station, so
 * the screen can say it once instead of under every row; null when the
 * rows differ or nothing is held back.
 */
export function sharedCeiling(rows: readonly Pick<LadderRow, "ceiling">[]): number | null {
  const first = rows[0]?.ceiling;
  if (first === undefined || first >= 4) return null;
  return rows.every((r) => r.ceiling === first) ? first : null;
}

export type CellState = "below" | "at" | "open" | "closed";

/** One cell of a row's track: passed, where it stands, still open above, or closed above its ceiling. */
export function cellState(row: Pick<LadderRow, "station" | "ceiling">, station: number): CellState {
  if (station < row.station) return "below";
  if (station === row.station) return "at";
  return station > row.ceiling ? "closed" : "open";
}

export type NextMove = "ceiling" | "wait" | "raise" | "confirm" | "ask";

/**
 * What the screen offers for going up a step. It mirrors the server's
 * rules only to choose a control; the server checks again on every POST.
 */
export function nextMove(row: Pick<LadderRow, "station" | "next" | "open_request">): NextMove {
  if (row.next === null) return "ceiling";
  if (row.next.checks.some((c) => !c.met)) return "wait";
  if (row.station < 3) return "raise";
  return row.open_request ? "confirm" : "ask";
}

export type RecordPart = "gains" | "losses" | "neither";

/**
 * A row's measured record as one bar: gains, losses, and what closed as
 * neither. Counts only; none when nothing has been measured.
 */
export function recordSegs(
  record: Pick<LadderRow["record"], "closed" | "gains" | "losses">,
  word: (part: RecordPart) => string,
): Seg[] {
  if (record.closed <= 0) return [];
  const neither = record.closed - record.gains - record.losses;
  return [
    { key: "gains", label: word("gains"), value: record.gains, tone: "ok" },
    { key: "losses", label: word("losses"), value: record.losses, tone: "alarm" },
    ...(neither >= 0
      ? [{ key: "neither", label: word("neither"), value: neither, tone: "soft" } as const]
      : []),
  ];
}
