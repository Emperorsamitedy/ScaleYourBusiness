// P7-74 — the quarterly guarantee job (v1 spec §8.4, §8.6): it runs per
// quarter, computes from ledger entries only, applies the credit without
// being asked, rolls forward below 8 plans, and an auditor recomputes it
// with no application access.

import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  guaranteeCredits,
  guaranteeEvaluations,
  intakeEvents,
  ownerNotices,
  subscriptions,
} from "../../db/schema";
import { verify } from "../../scripts/verify-guarantee.mjs";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { closePlan } from "../ledger/close";
import { openPlan } from "../ledger/plans";
import { exportForAudit, previousQuarter, quarterFee, runGuaranteeQuarter } from "./guarantee-run";
import { lockSubscription } from "./price-book";

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const subs = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(inArray(subscriptions.profile_id, ids));
  if (subs.length > 0) {
    await db.delete(guaranteeCredits).where(
      inArray(
        guaranteeCredits.subscription_id,
        subs.map((s) => s.id),
      ),
    );
  }
  await db.delete(guaranteeEvaluations).where(inArray(guaranteeEvaluations.profile_id, ids));
  await db.delete(ownerNotices).where(inArray(ownerNotices.profile_id, ids));
  await db.delete(subscriptions).where(inArray(subscriptions.profile_id, ids));
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

/** An Autonomous business with revenue measured, so its plans grade C. */
async function autonomous() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(connections).values({
    account_id: s.account_id,
    provider: "fixture",
    purpose: "measure",
    status: "connected",
    granted_scopes: ["read_revenue", "read_orders"],
  });
  const sub = await lockSubscription({
    profileId: s.profile_id,
    tier: "autonomous",
    billingCountry: "PT",
    vatCountry: "PT",
    now: new Date("2026-11-10T12:00:00Z"), // the day the price book's prices start
  });
  return { ...s, sub };
}

/** `n` plans opened in November and closed on 1 December 2026, each a €100 verified gain. */
async function closedGains(s: { profile_id: string; account_id: string }, n: number) {
  for (let i = 0; i < n; i++) {
    const { plan } = await openPlan({
      profileId: s.profile_id,
      accountId: s.account_id,
      provider: "fixture",
      action_summary: `Change ${i}`,
      hypothesis: "More sales",
      expected: {
        effect: money(10_000, "EUR"),
        low: money(5_000, "EUR"),
        high: money(15_000, "EUR"),
      },
      currency: "EUR",
      reversible: true,
      opened_by: "agent",
      station: 4,
      shadow: false,
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(plan.confidence_grade).toBe("C");
    await closePlan(
      plan.id,
      { observed_minor: 10_000, low_minor: 5_000, high_minor: 15_000, method_notes: "t" },
      new Date("2026-12-01T00:00:00Z"),
    );
  }
}

describe("§8.4 — the quarterly job, from the ledger alone", { timeout: 120_000 }, () => {
  it("a shortfall over 8+ plans writes the evaluation and a credit, unasked, and tells the owner", async () => {
    const s = await autonomous();
    await closedGains(s, 8);
    const now = new Date("2027-01-05T06:00:00Z");
    expect(previousQuarter(now)).toBe("2026-Q4");
    await runGuaranteeQuarter(now, null);

    const [evaluation] = await db
      .select()
      .from(guaranteeEvaluations)
      .where(
        and(
          eq(guaranteeEvaluations.profile_id, s.profile_id),
          eq(guaranteeEvaluations.quarter, "2026-Q4"),
        ),
      );
    // €800 verified against a €897 quarter: below 3×, so the next quarter is free.
    expect(evaluation?.fee_minor).toBe(quarterFee(s.sub));
    expect(evaluation?.result).toMatchObject({
      outcome: "credit",
      closed_plans: 8,
      verified: { amount_minor: 80_000 },
    });
    const [credit] = await db
      .select()
      .from(guaranteeCredits)
      .where(eq(guaranteeCredits.evaluation_id, evaluation!.id));
    expect(credit).toMatchObject({ amount_minor: 89_700, currency: "EUR", status: "pending" }); // payments unarmed
    const notices = await db
      .select()
      .from(ownerNotices)
      .where(
        and(eq(ownerNotices.profile_id, s.profile_id), eq(ownerNotices.kind, "guarantee_credit")),
      );
    expect(notices).toHaveLength(1);

    // Once per quarter, and the evaluation can't be edited afterwards.
    await runGuaranteeQuarter(now, null);
    expect(
      await db
        .select()
        .from(guaranteeEvaluations)
        .where(eq(guaranteeEvaluations.profile_id, s.profile_id)),
    ).toHaveLength(1);
    const refused = await db
      .update(guaranteeEvaluations)
      .set({ fee_minor: 1 })
      .where(eq(guaranteeEvaluations.id, evaluation!.id))
      .then(
        () => "updated",
        (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
      );
    expect(refused).toMatch(/append-only: UPDATE is not permitted/);

    // An auditor, from the export alone, gets the same hash and the same outcome.
    const exported = await exportForAudit(evaluation!.id);
    const report = verify(JSON.parse(JSON.stringify(exported)));
    expect(report).toMatchObject({
      hash_ok: true,
      outcome_ok: true,
      recomputed: { outcome: "credit", verified_minor: 80_000 },
    });
    // …and a tampered export fails the check.
    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.inputs.entries[0].net_minor = 999_999;
    expect(verify(tampered).hash_ok).toBe(false);
  });

  it("fewer than 8 plans rolls forward; the next quarter covers both quarters and both fees", async () => {
    const s = await autonomous();
    await closedGains(s, 3);
    await runGuaranteeQuarter(new Date("2027-01-05T06:00:00Z"), null);
    await runGuaranteeQuarter(new Date("2027-04-05T06:00:00Z"), null);
    const rows = await db
      .select()
      .from(guaranteeEvaluations)
      .where(eq(guaranteeEvaluations.profile_id, s.profile_id))
      .orderBy(sql`${guaranteeEvaluations.quarter}`);
    expect(rows.map((r) => [r.quarter, (r.result as { outcome: string }).outcome])).toEqual([
      ["2026-Q4", "rolled_forward"],
      ["2027-Q1", "rolled_forward"],
    ]);
    expect(rows[1]!.fee_minor).toBe(2 * quarterFee(s.sub));
    expect((rows[1]!.result as { closed_plans: number }).closed_plans).toBe(3);
    expect(
      await db
        .select()
        .from(guaranteeCredits)
        .where(
          inArray(
            guaranteeCredits.evaluation_id,
            rows.map((r) => r.id),
          ),
        ),
    ).toHaveLength(0);
  });
});
