// Home's next steps (docs/DASHBOARD-OVERHAUL.md C8) — pure. Up to three
// suggestions, worked out from what Home has already read and nothing
// else: no model call, no new figure. A decision waiting always comes
// first, so while one waits (or while the count is unknown) there are none.

export type NextStep = "connect" | "analytics" | "buffer" | "goal";

export interface NextInput {
  /** Decisions waiting; null while the count is unknown. */
  pending: number | null;
  /** Measurement connections being read; null while unknown. */
  connections: number | null;
  /** The live-visitors line's state; null before its first reading. */
  live: "live" | "not_connected" | "paused" | "unavailable" | null;
  /** Whether the owner stated a cash buffer; null when the forecast refused or is unread. */
  buffer: boolean | null;
  /** Goals set; null while unknown. */
  goals: number | null;
}

/** The screen each step opens. */
export const NEXT_HREF: Readonly<Record<NextStep, string>> = {
  connect: "/connections",
  analytics: "/connections",
  buffer: "/cash",
  goal: "/progress",
};

/**
 * Pure: whether the business has told nothing yet. A person who signs up
 * lands on Home before any interview (L8), and Lex offers it in the headline;
 * it is not a step in the list below, which would say it twice. Unknown is
 * not "nothing": the offer waits for the count.
 */
export function knowsNothing(facts: number | null | undefined): boolean {
  return facts === 0;
}

/** Pure: the steps, the most useful first. Only a known gap is a step: an unknown is not a zero. */
export function nextSteps(i: NextInput, limit = 3): NextStep[] {
  if (i.pending === null || i.pending > 0) return [];
  const out: NextStep[] = [];
  if (i.connections === 0) out.push("connect");
  else if (i.connections !== null && i.live === "not_connected") out.push("analytics");
  if (i.buffer === false) out.push("buffer");
  if (i.goals === 0) out.push("goal");
  return out.slice(0, limit);
}
