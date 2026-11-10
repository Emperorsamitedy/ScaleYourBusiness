// Closing a plan — the v1 build spec §3.2's ledger_entry, §3.3 (P7-34).
//
// At window close a plan gets exactly one entry: its verdict, the observed
// effect with its interval, net of the action's cost, and the forecast error
// that feeds calibration (§3.6). A later re-score is a NEW entry naming the
// one it corrects; nothing is ever edited (the table's trigger refuses it).
//
// The verdict comes from the interval, never from the point estimate alone:
//   verified_gain  the whole interval is above zero
//   loss           the whole interval is below zero
//   no_effect      it straddles zero, and is narrow enough to say so
//   inconclusive   it straddles zero and is too wide to say anything —
//                  or the plan's design is unmeasurable (logged, never scored)

import { and, eq } from "drizzle-orm";
import { toEur } from "../core/fx";
import { money } from "../core/money";
import { rateOn } from "../fx/ecb";
import { db } from "../../db";
import { ledgerEntries } from "../../db/schema";
import type { Entry } from "./chain";
import { appendEntry } from "./chain";
import type { Plan } from "./plans";
import { PlanError, duePlans, planById } from "./plans";

export type Verdict = Entry["verdict"];

/** What a capability's measurer observed over the window, in the plan's currency. */
export type Observation =
  | { observed_minor: number; low_minor: number; high_minor: number; method_notes: string }
  | { inconclusive: string };

export type Measurer = (plan: Plan) => Promise<Observation>;

/** Pure: the verdict an interval earns (see the header). */
export function verdictOf(
  plan: Pick<Plan, "design" | "expected_effect_minor">,
  o: Observation,
): Verdict {
  if (plan.design === "unmeasurable" || "inconclusive" in o) return "inconclusive";
  if (o.low_minor > 0) return "verified_gain";
  if (o.high_minor < 0) return "loss";
  // Straddling zero: "no effect" only when the interval is no wider than the
  // effect the plan expected — narrow enough that a real effect would show.
  const width = o.high_minor - o.low_minor;
  return width <= Math.max(Math.abs(plan.expected_effect_minor), 1) ? "no_effect" : "inconclusive";
}

function entryFields(plan: Plan, o: Observation) {
  const verdict = verdictOf(plan, o);
  if ("inconclusive" in o || plan.design === "unmeasurable") {
    return {
      verdict,
      observed_effect_minor: null,
      observed_low_minor: null,
      observed_high_minor: null,
      net_minor: null,
      forecast_error_minor: null,
      method_notes:
        plan.design === "unmeasurable"
          ? "Unmeasurable by design: logged, never scored, never counted."
          : (o as { inconclusive: string }).inconclusive,
    };
  }
  if (!(o.low_minor <= o.observed_minor && o.observed_minor <= o.high_minor)) {
    throw new PlanError("the observed effect sits inside its interval");
  }
  for (const v of [o.observed_minor, o.low_minor, o.high_minor]) {
    if (!Number.isSafeInteger(v)) throw new PlanError("money is whole minor units (rule 1)");
  }
  return {
    verdict,
    observed_effect_minor: o.observed_minor,
    observed_low_minor: o.low_minor,
    observed_high_minor: o.high_minor,
    net_minor: o.observed_minor - plan.cost_minor,
    forecast_error_minor: o.observed_minor - plan.expected_effect_minor,
    method_notes: o.method_notes,
  };
}

/**
 * The multi-market spec §A.4: the net projected into EUR, for SYB's own
 * cross-market roll-ups only — at the stored ECB rate for the close's day
 * (or the last published before it), with the rate, date and source kept
 * beside it. Never read by the counter, the guarantee or any owner- or
 * partner-facing surface. No stored rate: no projection, rather than a guess.
 */
async function reportingEur(currency: string, netMinor: number | null, day: string) {
  const none = {
    reporting_eur_minor: null,
    reporting_fx_rate: null,
    reporting_fx_date: null,
    reporting_fx_source: null,
  };
  if (netMinor === null) return none;
  if (currency === "EUR") return { ...none, reporting_eur_minor: netMinor };
  const rate = await rateOn(currency, day);
  if (!rate) return none;
  const eur = toEur(money(netMinor, currency), rate);
  return {
    reporting_eur_minor: eur.amount_minor,
    reporting_fx_rate: eur.fx_rate_to_eur,
    reporting_fx_date: eur.fx_rate_date,
    reporting_fx_source: eur.fx_source,
  };
}

/** ProofLedger.close_measurement — once per plan. */
export async function closePlan(planId: string, o: Observation, now = new Date()): Promise<Entry> {
  const plan = await planById(planId);
  if (!plan) throw new PlanError("no measurement plan by that id", 404);
  // The window is fixed at open and can't be cut short any more than extended.
  if (now.getTime() < Date.parse(plan.window_end)) {
    throw new PlanError("this plan's window hasn't ended — it is scored at window close", 409);
  }
  const fields = entryFields(plan, o);
  const reporting = await reportingEur(
    plan.currency,
    fields.net_minor,
    now.toISOString().slice(0, 10),
  );
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.plan_id, planId))
      .limit(1);
    if (closed) throw new PlanError("this plan is already closed", 409);
    return appendEntry(tx, {
      id: crypto.randomUUID(),
      plan_id: plan.id,
      profile_id: plan.profile_id,
      currency: plan.currency,
      corrects_entry_id: null,
      created_at: now.toISOString(),
      ...fields,
      ...reporting,
    });
  });
}

/** A re-score: a new entry naming the one it corrects (§3.5). Both stay. */
export async function correctEntry(
  entryId: string,
  o: Observation,
  reason: string,
  now = new Date(),
): Promise<Entry> {
  if (reason.trim() === "") throw new PlanError("a correction says why");
  const [original] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, entryId));
  if (!original) throw new PlanError("no ledger entry by that id", 404);
  const plan = await planById(original.plan_id);
  if (!plan) throw new PlanError("the entry's plan is missing", 500);
  const fields = entryFields(plan, o);
  const reporting = await reportingEur(
    plan.currency,
    fields.net_minor,
    now.toISOString().slice(0, 10),
  );
  return db.transaction(async (tx) =>
    appendEntry(tx, {
      id: crypto.randomUUID(),
      plan_id: plan.id,
      profile_id: plan.profile_id,
      currency: plan.currency,
      corrects_entry_id: original.id,
      created_at: now.toISOString(),
      ...fields,
      ...reporting,
      method_notes: `${fields.method_notes} Correction: ${reason.trim()}`,
    }),
  );
}

/** The entry that stands for a plan now: its latest correction, or its close. */
export async function standingEntry(planId: string): Promise<Entry | null> {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.plan_id, planId)));
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.seq > a.seq ? b : a));
}

/**
 * Close every due plan through its capability's measurer. A capability with
 * no measurer yet closes inconclusive, saying so; a measurer that throws
 * leaves the plan open for the next run rather than closing it on a guess.
 */
export async function closeDuePlans(args: {
  now?: Date;
  measurers: Readonly<Record<string, Measurer>>;
  onClosed?: (entry: Entry, plan: Plan) => Promise<void>;
  only?: readonly string[];
}): Promise<{ closed: number; left_open: number }> {
  const now = args.now ?? new Date();
  let closed = 0;
  let leftOpen = 0;
  for (const plan of await duePlans(now, args.only)) {
    const measurer = args.measurers[plan.capability];
    let o: Observation;
    try {
      o = measurer
        ? await measurer(plan)
        : { inconclusive: `No way to measure ${plan.capability.replace(/_/g, " ")} yet.` };
    } catch (error) {
      leftOpen += 1;
      console.error(
        JSON.stringify({
          event: "measurement_measurer_failed",
          account_id: plan.account_id,
          plan_id: plan.id,
          capability: plan.capability,
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
      continue;
    }
    let entry: Entry;
    try {
      entry = await closePlan(plan.id, o, now);
    } catch (error) {
      if (error instanceof PlanError && error.status === 409) continue; // closed by another run, or not due
      throw error;
    }
    closed += 1;
    await args.onClosed?.(entry, plan);
  }
  return { closed, left_open: leftOpen };
}
