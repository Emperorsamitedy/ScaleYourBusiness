// What the bell lists (docs/DASHBOARD-OVERHAUL.md B3): the things that need
// the owner, read off the menu's own counts (/api/nav) and nothing else.
// Pure, so the rule is tested: a zero is never listed, and the order is
// the order of urgency (a decision, a connection that stopped reading, a
// customer waiting).

import type { NavCounts } from "../../app/api/nav/route";

export interface AttentionItem {
  key: "decisions" | "paused" | "support";
  count: number;
  href: string;
}

export function attentionItems(
  counts: Pick<NavCounts, "pending" | "needs_reconnect" | "support_open"> | null,
): AttentionItem[] {
  if (!counts) return [];
  const all: AttentionItem[] = [
    { key: "decisions", count: counts.pending ?? 0, href: "/proposals" },
    { key: "paused", count: counts.needs_reconnect ?? 0, href: "/connections" },
    { key: "support", count: counts.support_open ?? 0, href: "/support" },
  ];
  return all.filter((i) => Number.isInteger(i.count) && i.count > 0);
}

/** The number on the bell: everything listed, added up. */
export function attentionCount(items: readonly AttentionItem[]): number {
  return items.reduce((sum, i) => sum + i.count, 0);
}
