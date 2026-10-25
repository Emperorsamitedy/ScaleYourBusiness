// Session J — P3-45..47. The case file holds every action and verdict
// under evidence ids; the review's causes survive only with evidence the
// case file holds; every cause category is weighed or the gap is
// recorded; suggestions enter the queue through suppression and nothing
// executes; and a goal still in alert after the recovery window goes to
// a person — never to a second automatic review. The model is a fake
// throughout: these are the rules code enforces around it.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  alertReviews,
  businessProfiles,
  connections,
  executions,
  fieldRecords,
  goals,
  intakeEvents,
  llmCalls,
  metricObservations,
  profileSnapshots,
  proposals,
  users,
  watchActivity,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import {
  approveProposal,
  createProposal,
  recordExecution,
  rejectProposal,
} from "../proposals/service";
import { SUPPRESSION_THRESHOLD } from "../trust/suppression";
import { shiftDay } from "../trust/series";
import { buildCaseFile, renderCaseFile } from "./case-file";
import { careState, recordDayZero } from "./day-zero";
import { setGoalMeasure } from "./goal-measure";
import { checkGoal } from "./progress";
import type { ReviewLlm } from "./review";
import {
  CAUSE_CATEGORIES,
  REVIEW,
  escalateIfStuck,
  openEscalations,
  resolveEscalation,
  runAlertReview,
  validateReview,
} from "./review";

const created: { account_id: string; profile_id: string }[] = [];
const DAY_MS = 86_400_000;
const T0 = new Date();
const TODAY = T0.toISOString().slice(0, 10);
const later = (days: number) => new Date(T0.getTime() + days * DAY_MS);

const scenario = {
  assumptions: [],
  base_case: {
    case: "base",
    statement: "Revenue rises.",
    profit_delta_monthly: null,
    formula: null,
  },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A business three months into a +20% revenue goal, revenue flat, actions doing nothing. */
async function stalled(executed = 2) {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-j2-${crypto.randomUUID()}@test.local`,
      display_name: "Session J owner",
      role: "owner",
    })
    .returning({ id: users.id });
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "stripe" })
    .returning({ id: connections.id });
  const rows = [];
  for (let d = shiftDay(TODAY, -60); d <= shiftDay(TODAY, 140); d = shiftDay(d, 1)) {
    rows.push({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "revenue.daily",
      dimensions: { currency: "EUR" },
      dimension_key: '{"currency":"EUR"}',
      period_date: d,
      value_minor: 10_000,
      currency: "EUR",
      observed_at: new Date().toISOString(),
    });
  }
  await db.insert(metricObservations).values(rows);

  const [g] = await db
    .insert(goals)
    .values({ profile_id: s.profile_id })
    .returning({ id: goals.id });
  await put(s.profile_id, `goals.${g!.id}.statement`, "Grow revenue by a fifth");
  await put(s.profile_id, `goals.${g!.id}.horizon`, "6_months");
  await setGoalMeasure(
    s.profile_id,
    g!.id,
    { metric: "revenue", target_per_30d: 360_000, currency: "EUR" },
    T0,
  );
  await recordDayZero(s.profile_id, crypto.randomUUID());

  const proposalIds: string[] = [];
  for (let i = 0; i < executed; i++) {
    const p = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "content_publishing", summary: `Weekly post series ${i + 1}` },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "undo" },
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    });
    await approveProposal({ proposalId: p.id, userId: u!.id });
    await recordExecution({ proposalId: p.id, result: { ok: true } });
    proposalIds.push(p.id);
  }
  return { ...s, user_id: u!.id, goal_id: g!.id, proposal_ids: proposalIds };
}

/** Drive three off-track weekly checks; the third raises the alert. */
async function toAlert(
  s: { profile_id: string; goal_id: string },
  review: Parameters<typeof checkGoal>[4],
) {
  const care = await careState(s.profile_id);
  await checkGoal(s.profile_id, s.goal_id, care, later(70));
  await checkGoal(s.profile_id, s.goal_id, care, later(77));
  return checkGoal(s.profile_id, s.goal_id, care, later(84), review);
}

/** A fake review that cites real ids out of the case file it is handed. */
function fakeReview(build: (ids: string[]) => unknown): ReviewLlm & { seen: string[] } {
  const seen: string[] = [];
  const llm: ReviewLlm = async ({ user }) => {
    seen.push(user);
    const ids = [...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!);
    return { text: JSON.stringify(build(ids)), calls: [] };
  };
  return Object.assign(llm, { seen });
}

const weighAll = (except: string[] = []) =>
  CAUSE_CATEGORIES.filter((c) => !except.includes(c)).map((category) => ({
    category,
    why_not: "the case file shows nothing pointing this way",
  }));

const honestReview = (ids: string[]) => {
  const proposal = ids.find((id) => id.startsWith("proposal:"))!;
  return {
    summary:
      "We published two post series and revenue did not move. Our advice did not work. We suggest changing the offer instead.",
    causes: [
      {
        category: "our_advice_was_wrong",
        statement: "The executed post series did nothing for revenue.",
        evidence: [proposal, "metric:revenue"],
        confidence: 0.7,
      },
      {
        category: "goal_unrealistic",
        statement: "Invented cause.",
        evidence: ["proposal:not-in-the-file"],
        confidence: 0.9,
      },
    ],
    considered: weighAll(["our_advice_was_wrong"]),
    suggestions: [
      { kind: "offer_change", title: "Bundle the bestseller", rationale: "r", evidence: ["goal"] },
      {
        kind: "revise_goal",
        title: "Give it nine months",
        rationale: "r",
        evidence: ["goal:baseline"],
      },
      { kind: "cold_outreach", title: "Email local offices", rationale: "r", evidence: ["goal"] },
    ],
  };
};

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(alertReviews).where(inArray(alertReviews.profile_id, ids));
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
    await db.delete(executions).where(inArray(executions.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(goals).where(inArray(goals.profile_id, ids));
  }
  for (const s of created) {
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    if (conns.length > 0) {
      await db.delete(metricObservations).where(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
      );
      await db.delete(connections).where(eq(connections.account_id, s.account_id));
    }
    await db.delete(llmCalls).where(eq(llmCalls.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-45 — the case file", () => {
  it("holds day zero, the goal, every action with its verdict, and missing pieces, under evidence ids", async () => {
    const s = await stalled(2);
    const file = await buildCaseFile(s.profile_id, s.goal_id, later(84));
    const ids = file.lines.map((l) => l.id);
    expect(ids).toContain("goal");
    expect(ids).toContain("goal:baseline");
    expect(ids).toContain("day_zero");
    expect(ids).toContain("metric:revenue");
    for (const p of s.proposal_ids) expect(ids).toContain(`proposal:${p}`);

    const line = file.lines.find((l) => l.id === `proposal:${s.proposal_ids[0]}`)!;
    expect(line.text).toContain("executed");
    expect(line.text).toContain("readback did_nothing");
    expect(file.lines.find((l) => l.id === "metric:revenue")!.text).toContain("+0%");
    expect(ids).toContain("report:none");
    expect(file.lines.find((l) => l.id === "metric:orders")!.text).toContain("not measured");

    // Deterministic: the same state renders the same file and hash.
    const again = await buildCaseFile(s.profile_id, s.goal_id, later(84));
    expect(again.hash).toBe(file.hash);
    expect(renderCaseFile(file)).toContain(`[proposal:${s.proposal_ids[0]}]`);
  });
});

describe("P3-46 — validation is code, not prompt", () => {
  const known = new Set(["goal", "proposal:a", "metric:revenue"]);

  it("drops a cause with no evidence or with evidence the file does not hold", () => {
    const { review, rejected } = validateReview(
      {
        summary: "s",
        causes: [
          {
            category: "our_advice_was_wrong",
            statement: "ok",
            evidence: ["proposal:a"],
            confidence: 0.6,
          },
          { category: "goal_unrealistic", statement: "no evidence", evidence: [], confidence: 0.6 },
          {
            category: "data_incomplete",
            statement: "made up",
            evidence: ["proposal:zzz"],
            confidence: 0.6,
          },
        ],
        considered: weighAll(["our_advice_was_wrong", "goal_unrealistic", "data_incomplete"]),
        suggestions: [],
      },
      known,
    );
    expect(review.causes.map((c) => c.category)).toEqual(["our_advice_was_wrong"]);
    expect(rejected.map((r) => r.reason)).toContain("a cause without evidence is not stated");
    expect(rejected.some((r) => r.reason.includes("proposal:zzz"))).toBe(true);
  });

  it("records every category neither named nor set aside — the review may not skip a question", () => {
    const { rejected } = validateReview(
      {
        summary: "s",
        causes: [
          { category: "external_change", statement: "x", evidence: ["goal"], confidence: 0.5 },
        ],
        considered: [],
        suggestions: [],
      },
      known,
    );
    const skipped = rejected.filter((r) => r.reason.startsWith("category not weighed"));
    expect(skipped).toHaveLength(CAUSE_CATEGORIES.length - 1);
    expect(skipped.some((r) => r.reason.endsWith("our_advice_was_wrong"))).toBe(true);
  });
});

describe("P3-46 — the review, end to end", () => {
  it("an alert runs one review; causes cite the case file; suggestions queue as pending; nothing executes", async () => {
    const s = await stalled(2);
    const llm = fakeReview(honestReview);
    const third = await toAlert(s, { llm });
    expect(third.alert_raised).toBe(true);
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0]).toContain("readback did_nothing");

    const [row] = await db
      .select()
      .from(alertReviews)
      .where(eq(alertReviews.profile_id, s.profile_id));
    expect(row?.outcome).toBe("reviewed");
    const review = row!.review as {
      causes: { category: string; evidence: string[] }[];
      suggestions: { kind: string; proposal_id: string | null; note: string | null }[];
    };
    // The invented cause is gone; the evidenced one stays.
    expect(review.causes.map((c) => c.category)).toEqual(["our_advice_was_wrong"]);
    expect(
      (row!.rejected as { reason: string }[]).some((r) => r.reason.includes("not-in-the-file")),
    ).toBe(true);

    // Action kinds became proposals; revise_goal stayed the owner's to decide.
    const queued = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.profile_id, s.profile_id), eq(proposals.module, "alert_review")));
    expect(queued.map((p) => p.status).sort()).toEqual(["pending", "pending"]);
    expect(review.suggestions.find((x) => x.kind === "revise_goal")?.proposal_id).toBeNull();
    const ran = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        inArray(
          executions.proposal_id,
          queued.map((p) => p.id),
        ),
      );
    expect(ran).toHaveLength(0);

    const log = await db
      .select({ kind: watchActivity.kind })
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, s.profile_id));
    expect(log.some((l) => l.kind === "alert_review")).toBe(true);
  });

  it("a kind the owner has declined three times is suggested but not proposed", async () => {
    const s = await stalled(1);
    for (let i = 0; i < SUPPRESSION_THRESHOLD; i++) {
      const p = await createProposal({
        profile_id: s.profile_id,
        module: "diagnosis",
        action: { kind: "cold_outreach", summary: `outreach ${i}` },
        scenario,
        reversibility: { level: "hard", if_you_change_your_mind: "can't unsend" },
        expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      });
      await rejectProposal({ proposalId: p.id, userId: s.user_id, reason: "not our style" });
    }
    await toAlert(s, { llm: fakeReview(honestReview) });
    const [row] = await db
      .select()
      .from(alertReviews)
      .where(eq(alertReviews.profile_id, s.profile_id));
    const outreach = (
      row!.review as { suggestions: { kind: string; proposal_id: string | null; note: string }[] }
    ).suggestions.find((x) => x.kind === "cold_outreach");
    expect(outreach?.proposal_id).toBeNull();
    expect(outreach?.note).toContain("declined");
  });

  it("a lagging goal raises nothing and gets no review", async () => {
    const s = await stalled(0);
    const llm = fakeReview(honestReview);
    const care = await careState(s.profile_id);
    // Revenue a little above flat: progress, but under 70% of the path.
    await db
      .update(metricObservations)
      .set({ value_minor: 10_800 })
      .where(
        inArray(
          metricObservations.connection_id,
          (
            await db
              .select({ id: connections.id })
              .from(connections)
              .where(eq(connections.account_id, s.account_id))
          ).map((c) => c.id),
        ),
      );
    for (const d of [70, 77, 84]) await checkGoal(s.profile_id, s.goal_id, care, later(d), { llm });
    expect(llm.seen).toHaveLength(0);
    expect(
      await db.select().from(alertReviews).where(eq(alertReviews.profile_id, s.profile_id)),
    ).toHaveLength(0);
  });
});

describe("P3-47 — a person, not a loop", () => {
  it("an unusable review goes straight to a person", async () => {
    const s = await stalled(1);
    await toAlert(s, {
      llm: fakeReview(() => ({ summary: "", causes: [], considered: [], suggestions: [] })),
    });
    const [row] = await db
      .select()
      .from(alertReviews)
      .where(eq(alertReviews.profile_id, s.profile_id));
    expect(row?.outcome).toBe("unusable");
    expect(row?.escalated_at).not.toBeNull();
    expect((await openEscalations()).some((e) => e.review_id === row!.id)).toBe(true);
  });

  it("a spent monthly budget skips the model and hands the case to a person", async () => {
    const s = await stalled(1);
    await db.insert(llmCalls).values({
      at: later(84).toISOString(),
      account_id: s.account_id,
      workload: "alert_review",
      model: "claude-opus-4-8",
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: REVIEW.monthly_cap_eur.toFixed(6),
    });
    const llm = fakeReview(honestReview);
    await toAlert(s, { llm });
    expect(llm.seen).toHaveLength(0);
    const [row] = await db
      .select()
      .from(alertReviews)
      .where(eq(alertReviews.profile_id, s.profile_id));
    expect(row?.outcome).toBe("skipped_cost_cap");
    expect(row?.escalation_reason).toContain("budget");
  });

  it("still in alert after the recovery window: escalated once, never reviewed again until resolved", async () => {
    const s = await stalled(1);
    const llm = fakeReview(honestReview);
    await toAlert(s, { llm });
    const care = await careState(s.profile_id);

    // Inside the window: still alert, not escalated.
    await checkGoal(s.profile_id, s.goal_id, care, later(91), { llm });
    expect(
      await escalateIfStuck(s.profile_id, s.goal_id, later(84 + REVIEW.recovery_window_days - 1)),
    ).toBe(false);
    // The window closes on a weekly check that still finds the alert.
    await checkGoal(s.profile_id, s.goal_id, care, later(84 + REVIEW.recovery_window_days), {
      llm,
    });
    const [row] = await db
      .select()
      .from(alertReviews)
      .where(eq(alertReviews.profile_id, s.profile_id));
    expect(row?.escalated_at).not.toBeNull();
    expect(row?.escalation_reason).toContain("recovery plan");

    // No second automatic review while a person holds the case.
    expect((await runAlertReview(s.profile_id, s.goal_id, { llm, now: later(200) })).kind).toBe(
      "escalated_already",
    );
    expect(llm.seen).toHaveLength(1);
    const told = await db
      .select({ detail: watchActivity.detail })
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, s.profile_id), eq(watchActivity.kind, "goal_escalated")),
      );
    expect(told).toHaveLength(1);
    expect(told[0]!.detail).toContain("A person at SYB");

    // Resolved by a person: the next alert may be reviewed again.
    await resolveEscalation(row!.id);
    expect((await openEscalations()).some((e) => e.review_id === row!.id)).toBe(false);
    expect((await runAlertReview(s.profile_id, s.goal_id, { llm, now: later(200) })).kind).toBe(
      "reviewed",
    );
  });

  it("a second alert inside the minimum interval is too soon", async () => {
    const s = await stalled(1);
    const llm = fakeReview(honestReview);
    await toAlert(s, { llm });
    const again = await runAlertReview(s.profile_id, s.goal_id, { llm, now: later(90) });
    expect(again.kind).toBe("too_soon");
  });
});
