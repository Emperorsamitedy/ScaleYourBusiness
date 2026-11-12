// Caps at station 4 — the v1 build spec §4.4 (P7-42).
//
// Required before a capability reaches station 4, stored per business per
// capability (never a global default), and enforced on the server from the
// stored row alone: what a client sends describes the action, it never sets
// a limit. checkCaps is pure; the engine hands it the action's own figures
// (the provider's capFacts) and today's count and spend so far.
//
//   within          act, and report after
//   needs_approval  over the soft ceiling: back to station 3 behaviour
//   refused         a hard limit, a blackout, or something never to touch

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { capabilityCaps } from "../../db/schema";
import type { Money } from "../core/money";
import { isIsoCurrency } from "../core/money";
import { LadderError } from "./ladder";

export type Caps = typeof capabilityCaps.$inferSelect;

export type Blackout =
  { from: string; to: string } | { weekday: number; from_hour: number; to_hour: number };

/** What one action would do, as its provider reads it from the action itself. */
export interface ActionFacts {
  /** The action's own size in money (a budget set, an order's total). */
  amount?: Money | null;
  /** How much it moves ad budget per day, signed. */
  spend_delta?: Money | null;
  /** The campaign, product, page or supplier ids it touches. */
  targets?: readonly string[];
}

export interface DaySoFar {
  actions: number;
  /** Absolute spend moved today, in the caps' currency. */
  spend_moved_minor: number;
}

export type CapsVerdict =
  | { verdict: "within" }
  | { verdict: "needs_approval"; reasons: string[] }
  | { verdict: "refused"; reasons: string[] };

function inBlackout(b: Blackout, now: Date): boolean {
  if ("weekday" in b) {
    const h = now.getUTCHours();
    return now.getUTCDay() === b.weekday && h >= b.from_hour && h < b.to_hour;
  }
  const day = now.toISOString().slice(0, 10);
  return day >= b.from && day <= b.to;
}

/** Pure: the action against the stored caps. */
export function checkCaps(
  caps: Caps | null,
  facts: ActionFacts | null,
  today: DaySoFar,
  now: Date,
): CapsVerdict {
  if (caps === null) {
    return { verdict: "refused", reasons: ["no limits are set for this capability"] };
  }
  if (facts === null) {
    // The provider can't say what the action is worth: never guess under a cap.
    return {
      verdict: "needs_approval",
      reasons: ["this action's size can't be read, so it waits for your yes"],
    };
  }
  const refused: string[] = [];
  const approval: string[] = [];

  const touched = (facts.targets ?? []).filter((t) => caps.never_touch.includes(t));
  if (touched.length > 0)
    refused.push(`it touches something you said never to touch (${touched.join(", ")})`);
  for (const b of caps.blackout_windows as Blackout[]) {
    if (inBlackout(b, now)) refused.push("it falls in a time you said nothing should act");
  }
  if (today.actions + 1 > caps.max_actions_per_day) {
    refused.push(
      `it would be action ${today.actions + 1} today, over your ${caps.max_actions_per_day}`,
    );
  }
  for (const m of [facts.amount, facts.spend_delta]) {
    if (m && m.currency !== caps.currency) {
      refused.push(`it is in ${m.currency}, and your limits are in ${caps.currency}`);
    }
  }
  const amount = facts.amount?.currency === caps.currency ? Math.abs(facts.amount.amount_minor) : 0;
  if (amount > caps.max_single_action_minor)
    refused.push("it is bigger than your largest single action");
  if (facts.spend_delta && facts.spend_delta.currency === caps.currency) {
    const moved = today.spend_moved_minor + Math.abs(facts.spend_delta.amount_minor);
    if (caps.max_daily_spend_delta_minor === null) {
      refused.push("it moves ad budget, and no daily budget limit is set");
    } else if (moved > caps.max_daily_spend_delta_minor) {
      refused.push("it would move more ad budget today than your limit");
    }
  }
  if (refused.length > 0) return { verdict: "refused", reasons: refused };
  if (caps.require_approval_above_minor !== null && amount > caps.require_approval_above_minor) {
    approval.push("it is above the amount you want to approve yourself");
  }
  return approval.length > 0
    ? { verdict: "needs_approval", reasons: approval }
    : { verdict: "within" };
}

export async function capsOf(profileId: string, capability: string): Promise<Caps | null> {
  const [row] = await db
    .select()
    .from(capabilityCaps)
    .where(
      and(eq(capabilityCaps.profile_id, profileId), eq(capabilityCaps.capability, capability)),
    );
  return row ?? null;
}

export interface CapsInput {
  currency: string;
  max_daily_spend_delta_minor: number | null;
  max_single_action_minor: number;
  max_actions_per_day: number;
  blackout_windows: Blackout[];
  require_approval_above_minor: number | null;
  never_touch: string[];
}

function validBlackout(b: unknown): b is Blackout {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  if ("weekday" in o) {
    return (
      Number.isInteger(o.weekday) &&
      (o.weekday as number) >= 0 &&
      (o.weekday as number) <= 6 &&
      Number.isInteger(o.from_hour) &&
      Number.isInteger(o.to_hour) &&
      (o.from_hour as number) >= 0 &&
      (o.to_hour as number) <= 24 &&
      (o.from_hour as number) < (o.to_hour as number)
    );
  }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return (
    typeof o.from === "string" &&
    typeof o.to === "string" &&
    date.test(o.from) &&
    date.test(o.to) &&
    o.from <= o.to
  );
}

/** Set a capability's caps — the owner's own limits. Every figure is checked here, not trusted. */
export async function setCaps(args: {
  profileId: string;
  capability: string;
  caps: CapsInput;
  by: string | null;
}): Promise<Caps> {
  const c = args.caps;
  if (!isIsoCurrency(c.currency)) throw new LadderError("limits need their currency", 422);
  const whole = (n: number | null) => n === null || (Number.isSafeInteger(n) && n >= 0);
  if (
    !whole(c.max_daily_spend_delta_minor) ||
    !whole(c.max_single_action_minor) ||
    !whole(c.require_approval_above_minor) ||
    !Number.isSafeInteger(c.max_actions_per_day) ||
    c.max_actions_per_day < 0
  ) {
    throw new LadderError("each limit is a whole, non-negative amount", 422);
  }
  if (!Array.isArray(c.blackout_windows) || !c.blackout_windows.every(validBlackout)) {
    throw new LadderError("a quiet time is a date range or a weekday's hours", 422);
  }
  if (
    !Array.isArray(c.never_touch) ||
    !c.never_touch.every((t) => typeof t === "string" && t.trim() !== "")
  ) {
    throw new LadderError("each thing never to touch is named by its id", 422);
  }
  const values = {
    currency: c.currency,
    max_daily_spend_delta_minor: c.max_daily_spend_delta_minor,
    max_single_action_minor: c.max_single_action_minor,
    max_actions_per_day: c.max_actions_per_day,
    blackout_windows: c.blackout_windows,
    require_approval_above_minor: c.require_approval_above_minor,
    never_touch: c.never_touch.map((t) => t.trim()),
    set_by: args.by,
    set_at: new Date().toISOString(),
  };
  const [row] = await db
    .insert(capabilityCaps)
    .values({ profile_id: args.profileId, capability: args.capability, ...values })
    .onConflictDoUpdate({
      target: [capabilityCaps.profile_id, capabilityCaps.capability],
      set: values,
    })
    .returning();
  return row!;
}
