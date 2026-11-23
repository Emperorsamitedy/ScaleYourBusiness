// Grow's tools, said plainly (2026-11-23, the owner: Grow's screens "can't
// really be comprehended easily and it's hard to know what they are for").
// Pure: which tool each screen is, which half of Grow it sits in, and the
// one figure its card on Grow's front page may show. The words are the
// catalogue's (grow.tools.<tool>), the menu's names are nav.item's, and which
// tools a business sees is the menu's own rule (AppFrame visibleGroups).

import type { NavCounts } from "../../app/api/nav/route";

export const GROW_TOOLS = [
  "posts",
  "ads",
  "site",
  "test",
  "customers",
  "reviews",
  "messages",
  "carts",
  "deals",
] as const;
export type GrowTool = (typeof GROW_TOOLS)[number];

/** Each tool's screen. */
export const TOOL_HREF: Readonly<Record<GrowTool, string>> = {
  posts: "/content",
  ads: "/studio",
  site: "/site",
  test: "/simulate",
  customers: "/customers",
  reviews: "/reviews",
  messages: "/support",
  carts: "/carts",
  deals: "/pipeline",
};

/** Pure: the tool a screen is, or null for a screen that is not one of Grow's tools. */
export function toolFor(href: string): GrowTool | null {
  return GROW_TOOLS.find((t) => TOOL_HREF[t] === href) ?? null;
}

/** The two halves of Grow, as the front page and the rail name them. */
export type GrowHalf = "bring" | "keep";
export const TOOL_HALF: Readonly<Record<GrowTool, GrowHalf>> = {
  posts: "bring",
  ads: "bring",
  site: "bring",
  test: "bring",
  customers: "keep",
  reviews: "keep",
  messages: "keep",
  carts: "keep",
  deals: "keep",
};

/**
 * Pure: the one figure a tool's card shows, and only where there is a
 * counted one: decisions it drafted that wait for the owner, or messages
 * waiting for an answer. With nothing counted the card says nothing about
 * its state rather than guess.
 */
export function toolStatus(
  tool: GrowTool,
  counts: Pick<NavCounts, "by_module" | "support_open"> | null,
): { kind: "waiting" | "unanswered"; count: number } | null {
  if (!counts) return null;
  const module: Partial<Record<GrowTool, string>> = {
    posts: "content",
    site: "site",
    deals: "pipeline",
  };
  if (tool === "messages") {
    return counts.support_open > 0 ? { kind: "unanswered", count: counts.support_open } : null;
  }
  const key = module[tool];
  const n = key ? (counts.by_module[key] ?? 0) : 0;
  return n > 0 ? { kind: "waiting", count: n } : null;
}
