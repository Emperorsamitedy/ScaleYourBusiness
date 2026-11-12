// Standing rules — the v1 build spec §4.5 (P7-44).
//
// A typed object, not free text: {scope, condition, action, expiry}. Every
// rule expires — 90 days by default — and surfaces for renewal in the last
// RENEWAL_NOTICE_DAYS before it does. "A rule with no expiry is how an agent
// quietly drifts out of its mandate."
//
// What expiry means depends on which way the rule points (D34): an "allow"
// widens what SYB may do, so once expired it stops applying; a "forbid" or
// "require_approval" narrows it, so it keeps applying past its date — still
// flagged for renewal — rather than loosening SYB's leash by the calendar.
//
// The owner's free-text boundaries (goals.owner_boundaries → hard limits,
// Phase 3 rule 14) stay as they are: they are the owner's never-list, read
// at proposal time. Standing rules govern what the ladder lets a capability
// do on its own.

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { standingRules } from "../../db/schema";
import type { Money } from "../core/money";
import { isIsoCurrency } from "../core/money";
import { LadderError } from "./ladder";

export type StandingRule = typeof standingRules.$inferSelect;
export type RuleAction = StandingRule["action"];

export const DEFAULT_RULE_DAYS = 90;
export const RENEWAL_NOTICE_DAYS = 14;
const DAY = 86_400_000;

export type RuleCondition =
  | { kind: "always" }
  | { kind: "amount_above"; minor: number; currency: string }
  | { kind: "target"; ids: string[] }
  | { kind: "weekday"; days: number[] };

export function isRuleCondition(c: unknown): c is RuleCondition {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  switch (o.kind) {
    case "always":
      return true;
    case "amount_above":
      return (
        Number.isSafeInteger(o.minor) &&
        (o.minor as number) >= 0 &&
        typeof o.currency === "string" &&
        isIsoCurrency(o.currency)
      );
    case "target":
      return (
        Array.isArray(o.ids) &&
        o.ids.length > 0 &&
        o.ids.every((i) => typeof i === "string" && i.trim() !== "")
      );
    case "weekday":
      return (
        Array.isArray(o.days) &&
        o.days.length > 0 &&
        o.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      );
    default:
      return false;
  }
}

export async function addStandingRule(args: {
  profileId: string;
  scope: string;
  condition: unknown;
  action: RuleAction;
  words: string;
  by: string | null;
  days?: number;
  now?: Date;
}): Promise<StandingRule> {
  if (!isRuleCondition(args.condition)) {
    throw new LadderError(
      "a rule's condition is one of: always, above an amount, these items, these weekdays",
      422,
    );
  }
  if (args.scope.trim() === "") throw new LadderError("say what the rule applies to", 422);
  if (args.words.trim() === "") throw new LadderError("say the rule in words", 422);
  const days = args.days ?? DEFAULT_RULE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new LadderError("a rule lasts between a day and a year — every rule expires", 422);
  }
  const now = args.now ?? new Date();
  const [row] = await db
    .insert(standingRules)
    .values({
      profile_id: args.profileId,
      scope: args.scope.trim(),
      condition: args.condition,
      action: args.action,
      words: args.words.trim(),
      expires_at: new Date(now.getTime() + days * DAY).toISOString(),
      created_by: args.by,
      created_at: now.toISOString(),
    })
    .returning();
  return row!;
}

/** Renew for another term from today. */
export async function renewStandingRule(args: {
  profileId: string;
  ruleId: string;
  days?: number;
  now?: Date;
}): Promise<StandingRule> {
  const now = args.now ?? new Date();
  const days = args.days ?? DEFAULT_RULE_DAYS;
  const [row] = await db
    .update(standingRules)
    .set({
      expires_at: new Date(now.getTime() + days * DAY).toISOString(),
      renewed_at: now.toISOString(),
    })
    .where(
      and(
        eq(standingRules.id, args.ruleId),
        eq(standingRules.profile_id, args.profileId),
        isNull(standingRules.retired_at),
      ),
    )
    .returning();
  if (!row) throw new LadderError("no such rule", 404);
  return row;
}

export async function retireStandingRule(args: { profileId: string; ruleId: string; now?: Date }) {
  await db
    .update(standingRules)
    .set({ retired_at: (args.now ?? new Date()).toISOString() })
    .where(and(eq(standingRules.id, args.ruleId), eq(standingRules.profile_id, args.profileId)));
}

export async function standingRulesOf(profileId: string): Promise<StandingRule[]> {
  return db
    .select()
    .from(standingRules)
    .where(and(eq(standingRules.profile_id, profileId), isNull(standingRules.retired_at)))
    .orderBy(asc(standingRules.expires_at));
}

/** D34: does this rule still bind? An expired allow stops; an expired forbid keeps binding. */
export function ruleApplies(rule: StandingRule, now: Date): boolean {
  if (rule.retired_at !== null) return false;
  if (rule.action === "allow") return Date.parse(rule.expires_at) > now.getTime();
  return true;
}

/** Rules that need the owner's renewal: expired, or within the notice window. */
export function dueForRenewal(rules: readonly StandingRule[], now: Date): StandingRule[] {
  return rules.filter(
    (r) =>
      r.retired_at === null &&
      Date.parse(r.expires_at) - now.getTime() <= RENEWAL_NOTICE_DAYS * DAY,
  );
}

export interface RuleSubject {
  capability: string;
  amount?: Money | null;
  targets?: readonly string[];
}

function matches(c: RuleCondition, a: RuleSubject, now: Date): boolean {
  switch (c.kind) {
    case "always":
      return true;
    case "amount_above":
      return (
        a.amount != null &&
        a.amount.currency === c.currency &&
        Math.abs(a.amount.amount_minor) > c.minor
      );
    case "target":
      return (a.targets ?? []).some((t) => c.ids.includes(t));
    case "weekday":
      return c.days.includes(now.getUTCDay());
  }
}

/**
 * What the rules say about one action: the strictest binding rule wins —
 * forbid over require_approval over allow. None binding: "none".
 */
export function rulesVerdict(
  rules: readonly StandingRule[],
  action: RuleSubject,
  now: Date,
): { action: RuleAction | "none"; rules: StandingRule[] } {
  const binding = rules.filter(
    (r) =>
      ruleApplies(r, now) &&
      (r.scope === "*" || r.scope === action.capability) &&
      isRuleCondition(r.condition) &&
      matches(r.condition, action, now),
  );
  for (const level of ["forbid", "require_approval", "allow"] as const) {
    const hit = binding.filter((r) => r.action === level);
    if (hit.length > 0) return { action: level, rules: hit };
  }
  return { action: "none", rules: [] };
}
