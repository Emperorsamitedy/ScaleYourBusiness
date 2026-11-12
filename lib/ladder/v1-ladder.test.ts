// The Trust Ladder in full — the v1 build spec §4.7's acceptance criteria
// and Phase 2's gate (§12): "No external call reachable around the ladder.
// Emergency stop under one second. Day-30 shadow summary renders."

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  capabilityCaps,
  capabilityStations,
  connections,
  executionHalts,
  executions,
  intakeEvents,
  ownerNotices,
  promotionRequests,
  proposals,
  standingRules,
  users,
} from "../../db/schema";
import { money } from "../core/money";
import { haltExecutions } from "../execution/engine";
import { bootstrapIntake } from "../intake/service";
import { closePlan } from "../ledger/close";
import { closeAndRecord } from "../ledger/close-due";
import type { OpenPlanInput } from "../ledger/plans";
import { openPlan } from "../ledger/plans";
import { createProposal } from "../proposals/service";
import type { Caps } from "./caps";
import { checkCaps, localClock, setCaps } from "./caps";
import { dayStart } from "./limits";
import {
  DEFAULT_STATION,
  NEW_BUSINESS_SHADOW_DAYS,
  authorize,
  startShadowPeriod,
  stationOf,
} from "./ladder";
import { changeStation, confirmPromotion, eligibility, requestPromotion } from "./promotion";
import { shadowSummary } from "./shadow-summary";
import {
  DEFAULT_RULE_DAYS,
  addStandingRule,
  dueForRenewal,
  ruleApplies,
  rulesVerdict,
} from "./standing-rules";

const created: { account_id: string; profile_id: string }[] = [];
const PAST = new Date("2026-01-01T00:00:00Z");

async function fresh(opts: { measured?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  if (opts.measured) {
    await db.insert(connections).values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
    });
  }
  return s;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length === 0) return;
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  for (const s of created) {
    await db.delete(executionHalts).where(eq(executionHalts.account_id, s.account_id));
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  // Plans, entries and ladder events stay: they are permanent by design.
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

function plan(
  s: { profile_id: string; account_id: string },
  over: Partial<OpenPlanInput> = {},
): OpenPlanInput {
  return {
    profileId: s.profile_id,
    accountId: s.account_id,
    provider: "fixture",
    action_summary: "Set a fixture value",
    hypothesis: "Revenue rises a little",
    expected: {
      effect: money(10_000, "EUR"),
      low: money(5_000, "EUR"),
      high: money(15_000, "EUR"),
    },
    currency: "EUR",
    reversible: true,
    opened_by: "agent",
    station: 2,
    shadow: true,
    now: PAST,
    ...over,
  };
}

const gain = { observed_minor: 12_000, low_minor: 6_000, high_minor: 18_000, method_notes: "t" };
const loss = { observed_minor: -8_000, low_minor: -12_000, high_minor: -4_000, method_notes: "t" };
const bigLoss = {
  observed_minor: -30_000,
  low_minor: -40_000,
  high_minor: -20_000,
  method_notes: "t",
};

async function closed(
  s: { profile_id: string; account_id: string },
  o: typeof gain,
  over: Partial<OpenPlanInput> = {},
) {
  const { plan: p } = await openPlan(plan(s, over));
  await closePlan(p.id, o);
  return p;
}

describe("§4.2 — new businesses start in shadow; the five live ones stay at 3 (D18)", () => {
  it("a business with no shadow period is at station 3, as before", async () => {
    const s = await fresh();
    expect(DEFAULT_STATION).toBe(3);
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(3);
  });

  it("a new business is at station 2 for its first 30 days, then 3", async () => {
    const s = await fresh();
    expect(NEW_BUSINESS_SHADOW_DAYS).toBe(30);
    await startShadowPeriod(s.profile_id, new Date());
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(2);
    expect((await authorize(s.profile_id, "meta_ads")).state).toBe("SHADOW");
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await stationOf(s.profile_id, "meta_ads", db, later)).toBe(3);
  });
});

describe("§4.3 — promotion rules, enforced by the server", () => {
  it("1 → 2 needs a healthy connector for the capability", async () => {
    const s = await fresh();
    await changeStation({ ...ids(s), capability: "fixture", to: 1, by: null });
    await expect(
      changeStation({ ...ids(s), capability: "fixture", to: 2, by: null }),
    ).rejects.toThrow(/connect a source/);
    await db.insert(connections).values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
    });
    await changeStation({ ...ids(s), capability: "fixture", to: 2, by: null });
    expect(await stationOf(s.profile_id, "fixture")).toBe(2);
  });

  it("2 → 3 needs ≥ 5 closed shadow plans, ≥ 60 % gains, net positive, no big loss", async () => {
    const s = await fresh({ measured: true });
    await changeStation({ ...ids(s), capability: "fixture", to: 1, by: null });
    await changeStation({ ...ids(s), capability: "fixture", to: 2, by: null });
    for (let i = 0; i < 4; i++) await closed(s, gain);
    let e = await eligibility({ ...ids(s), capability: "fixture", to: 3 });
    expect(e.eligible).toBe(false);
    expect(e.checks.find((c) => c.rule === "closed_shadow_plans")?.detail).toBe(
      "4 of 5 shadow plans closed",
    );
    await closed(s, loss);
    e = await eligibility({ ...ids(s), capability: "fixture", to: 3 });
    expect(e.eligible).toBe(true); // 4 of 5 gains, net positive, the loss within 2× its low end
    await changeStation({ ...ids(s), capability: "fixture", to: 3, by: null });
    expect(await stationOf(s.profile_id, "fixture")).toBe(3);
  });

  it("a shadow loss bigger than twice its forecast's low end blocks 2 → 3", async () => {
    const s = await fresh({ measured: true });
    await changeStation({ ...ids(s), capability: "fixture", to: 1, by: null });
    await changeStation({ ...ids(s), capability: "fixture", to: 2, by: null });
    for (let i = 0; i < 6; i++) await closed(s, gain);
    await closed(s, bigLoss); // |−30 000| > 2 × 5 000
    const e = await eligibility({ ...ids(s), capability: "fixture", to: 3 });
    expect(e.checks.find((c) => c.rule === "no_big_loss")?.met).toBe(false);
    await expect(
      changeStation({ ...ids(s), capability: "fixture", to: 3, by: null }),
    ).rejects.toThrow(/twice the low end/);
  });

  it("a capability moves one station at a time — no jumping", async () => {
    const s = await fresh({ measured: true });
    await changeStation({ ...ids(s), capability: "fixture", to: 1, by: null });
    await expect(
      changeStation({ ...ids(s), capability: "fixture", to: 3, by: null }),
    ).rejects.toThrow(/one station at a time/);
  });

  it("lowering needs no evidence", async () => {
    const s = await fresh();
    await changeStation({ ...ids(s), capability: "meta_ads", to: 2, by: null });
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(2);
  });

  it("3 → 4 needs 10 executed actions, 70 % gains, caps, and a separate confirmation", async () => {
    const s = await fresh({ measured: true });
    await expect(
      changeStation({ ...ids(s), capability: "fixture", to: 4, by: null }),
    ).rejects.toThrow(/separate confirmation/);
    await expect(requestPromotion({ ...ids(s), capability: "fixture", by: null })).rejects.toThrow(
      /0 of 10 approved actions/,
    );

    for (let i = 0; i < 10; i++) {
      const p = await createProposal({
        profile_id: s.profile_id,
        module: "diagnosis",
        action: { kind: "operations_change", summary: `fixture ${i}` },
        scenario: {} as never,
        reversibility: { level: "easy", if_you_change_your_mind: "undo" },
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await db.insert(executions).values({
        proposal_id: p.id,
        profile_id: s.profile_id,
        account_id: s.account_id,
        provider: "fixture",
        op: "set_value",
        status: "succeeded",
      });
      await closed(s, i < 8 ? gain : loss, { shadow: false, station: 3 });
    }
    await expect(requestPromotion({ ...ids(s), capability: "fixture", by: null })).rejects.toThrow(
      /set this capability's limits first/,
    );
    await setCaps({ profileId: s.profile_id, capability: "fixture", caps: CAPS, by: null });

    const req = await requestPromotion({ ...ids(s), capability: "fixture", by: null });
    // Asking is not promoting: still 3 until the separate confirmation.
    expect(await stationOf(s.profile_id, "fixture")).toBe(3);
    await confirmPromotion({ ...ids(s), requestId: req.request_id, by: null });
    expect(await stationOf(s.profile_id, "fixture")).toBe(4);
    await expect(
      confirmPromotion({ ...ids(s), requestId: req.request_id, by: null }),
    ).rejects.toThrow(/no open request/);
  });

  it("a confirmation that comes too late is refused", async () => {
    const s = await fresh();
    const [r] = await db
      .insert(promotionRequests)
      .values({
        profile_id: s.profile_id,
        capability: "fixture",
        to_station: 4,
        eligibility: {},
        expires_at: "2026-01-02T00:00:00Z",
      })
      .returning();
    await expect(confirmPromotion({ ...ids(s), requestId: r!.id, by: null })).rejects.toThrow(
      /run out/,
    );
  });

  it("purchase orders never reach station 4", async () => {
    const s = await fresh();
    const e = await eligibility({ ...ids(s), capability: "purchase_order", to: 4 });
    expect(e.eligible).toBe(false);
    expect(e.checks[0]?.detail).toMatch(/never goes past station 3/);
  });

  it("no global switch: setting every capability at once isn't an API", async () => {
    const ladder = await import("./ladder");
    const promotion = await import("./promotion");
    const names = [...Object.keys(ladder), ...Object.keys(promotion)];
    expect(names.filter((n) => /all/i.test(n) && /promot|autonom|raise/i.test(n))).toEqual([]);
  });
});

const CAPS = {
  currency: "EUR",
  max_daily_spend_delta_minor: 5_000,
  max_single_action_minor: 20_000,
  max_actions_per_day: 3,
  blackout_windows: [{ from: "2026-12-24", to: "2026-12-26" }],
  require_approval_above_minor: 10_000,
  never_touch: ["campaign-flagship"],
};

describe("§4.4 — caps at station 4, from the stored row only", () => {
  const caps = {
    ...CAPS,
    profile_id: "x",
    capability: "meta_ads",
    set_by: null,
    set_at: "",
  } as Caps;
  const day = { actions: 0, spend_moved_minor: 0 };
  const at = new Date("2026-11-11T12:00:00Z");

  it("within: act and report after", () => {
    expect(checkCaps(caps, { amount: money(5_000, "EUR") }, day, at)).toEqual({
      verdict: "within",
    });
  });

  it("above the soft ceiling: back to station 3", () => {
    expect(checkCaps(caps, { amount: money(15_000, "EUR") }, day, at).verdict).toBe(
      "needs_approval",
    );
  });

  it("refused: too big, too many, a blackout, never-touch, budget moved, wrong currency", () => {
    expect(checkCaps(caps, { amount: money(25_000, "EUR") }, day, at).verdict).toBe("refused");
    expect(
      checkCaps(caps, { amount: money(1, "EUR") }, { actions: 3, spend_moved_minor: 0 }, at)
        .verdict,
    ).toBe("refused");
    expect(
      checkCaps(caps, { amount: money(1, "EUR") }, day, new Date("2026-12-25T10:00:00Z")).verdict,
    ).toBe("refused");
    expect(checkCaps(caps, { targets: ["campaign-flagship"] }, day, at).verdict).toBe("refused");
    expect(
      checkCaps(
        caps,
        { spend_delta: money(4_000, "EUR") },
        { actions: 0, spend_moved_minor: 2_000 },
        at,
      ).verdict,
    ).toBe("refused");
    expect(checkCaps(caps, { amount: money(1, "HUF") }, day, at).verdict).toBe("refused");
  });

  it("no caps, nothing acts; an action whose size can't be read waits for a yes", () => {
    expect(checkCaps(null, { amount: money(1, "EUR") }, day, at).verdict).toBe("refused");
    expect(checkCaps(caps, null, day, at).verdict).toBe("needs_approval");
  });

  it("setting caps checks every figure — a tampered payload is refused, not stored", async () => {
    const s = await fresh();
    await expect(
      setCaps({
        profileId: s.profile_id,
        capability: "meta_ads",
        caps: { ...CAPS, max_single_action_minor: -1 },
        by: null,
      }),
    ).rejects.toThrow(/whole, non-negative/);
    await expect(
      setCaps({
        profileId: s.profile_id,
        capability: "meta_ads",
        caps: { ...CAPS, max_single_action_minor: 1.5 },
        by: null,
      }),
    ).rejects.toThrow(/whole, non-negative/);
    await expect(
      setCaps({
        profileId: s.profile_id,
        capability: "meta_ads",
        caps: { ...CAPS, blackout_windows: [{ weekday: 9, from_hour: 0, to_hour: 2 }] },
        by: null,
      }),
    ).rejects.toThrow(/quiet time/);
    const rows = await db
      .select()
      .from(capabilityCaps)
      .where(eq(capabilityCaps.profile_id, s.profile_id));
    expect(rows).toHaveLength(0);
  });
});

describe("§4.3 — two consecutive losses demote automatically, never silently", () => {
  it("drops the capability one station and tells the owner, with both entries", async () => {
    const s = await fresh({ measured: true });
    const t0 = new Date("2026-02-01T00:00:00Z");
    const a = (await openPlan(plan(s, { shadow: false, station: 3, now: t0 }))).plan;
    const b = (
      await openPlan(plan(s, { shadow: false, station: 3, now: new Date(t0.getTime() + 1_000) }))
    ).plan;
    await closeAndRecord({
      now: new Date("2026-04-01T00:00:00Z"),
      only: [a.id, b.id],
      measurers: { fixture: async () => loss },
    });
    expect(await stationOf(s.profile_id, "fixture")).toBe(2);
    const notices = await db
      .select()
      .from(ownerNotices)
      .where(
        and(eq(ownerNotices.profile_id, s.profile_id), eq(ownerNotices.kind, "auto_demotion")),
      );
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as {
      from: number;
      to: number;
      plan_ids: string[];
      entry_ids: string[];
    };
    expect(payload).toMatchObject({ from: 3, to: 2 });
    expect(payload.plan_ids.sort()).toEqual([a.id, b.id].sort());
    expect(payload.entry_ids).toHaveLength(2);
  });

  it("one loss, or a gain between two, doesn't demote", async () => {
    const s = await fresh({ measured: true });
    const t0 = new Date("2026-02-01T00:00:00Z");
    const ps: Awaited<ReturnType<typeof openPlan>>["plan"][] = [];
    for (let i = 0; i < 3; i++) {
      ps.push(
        (
          await openPlan(
            plan(s, { shadow: false, station: 3, now: new Date(t0.getTime() + i * 1_000) }),
          )
        ).plan,
      );
    }
    await closeAndRecord({
      now: new Date("2026-04-01T00:00:00Z"),
      only: ps.map((p) => p.id),
      measurers: { fixture: async (p) => (p.id === ps[1]!.id ? gain : loss) },
    });
    expect(await stationOf(s.profile_id, "fixture")).toBe(3);
  });
});

describe("PHASE 2 GATE — emergency stop under one second, cancelling every pending approval", () => {
  it("sets every capability to 1 and cancels pending proposals, in under a second", async () => {
    const s = await fresh();
    const [u] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `ladder-${randomUUID()}@test.local`,
        display_name: "Ladder test owner",
        role: "owner",
      })
      .returning({ id: users.id });
    const pending = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "operations_change", summary: "waits" },
      scenario: {} as never,
      reversibility: { level: "easy", if_you_change_your_mind: "undo" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const started = performance.now();
    await haltExecutions({ accountId: s.account_id, userId: u!.id });
    const took = performance.now() - started;
    expect(took).toBeLessThan(1_000);
    const stations = await db
      .select()
      .from(capabilityStations)
      .where(eq(capabilityStations.profile_id, s.profile_id));
    expect(stations.length).toBeGreaterThan(0);
    expect(stations.every((r) => r.station === 1)).toBe(true);
    const [p] = await db.select().from(proposals).where(eq(proposals.id, pending.id));
    expect(p?.status).not.toBe("pending");
  });
});

describe("PHASE 2 GATE — the day-30 shadow summary", () => {
  it("renders correctly for a business with zero gains", async () => {
    const s = await fresh({ measured: true });
    const t0 = new Date("2026-02-01T00:00:00Z");
    await closed(s, loss, { now: t0 });
    await closed(
      s,
      { observed_minor: 100, low_minor: -2_000, high_minor: 2_000, method_notes: "t" },
      { now: t0 },
    );
    const summary = await shadowSummary(s.profile_id, new Date("2026-01-31T00:00:00Z"));
    expect(summary).toMatchObject({
      changes: 2,
      gained: { count: 0, total: [] },
      nothing: 1,
      lost: { count: 1, total: [money(-8_000, "EUR")] },
      net: [money(-8_000, "EUR")],
    });
  });

  it("counts gains, nothing and losses the way the spec's sentence does", async () => {
    const s = await fresh({ measured: true });
    const t0 = new Date("2026-02-01T00:00:00Z");
    await closed(s, gain, { now: t0 });
    await closed(s, gain, { now: t0 });
    await closed(s, loss, { now: t0 });
    const summary = await shadowSummary(s.profile_id, new Date("2026-01-31T00:00:00Z"));
    expect(summary.changes).toBe(3);
    expect(summary.gained).toEqual({ count: 2, total: [money(24_000, "EUR")] });
    expect(summary.net).toEqual([money(16_000, "EUR")]);
  });
});

describe("§4.5 — standing rules are typed, and every one expires", () => {
  it("defaults to 90 days and refuses a rule that never ends", async () => {
    const s = await fresh();
    const now = new Date("2026-11-10T00:00:00Z");
    const r = await addStandingRule({
      profileId: s.profile_id,
      scope: "meta_ads",
      condition: { kind: "always" },
      action: "require_approval",
      words: "Ask me before any ad change",
      by: null,
      now,
    });
    expect(DEFAULT_RULE_DAYS).toBe(90);
    expect(Date.parse(r.expires_at) - now.getTime()).toBe(90 * 86_400_000);
    await expect(
      addStandingRule({
        profileId: s.profile_id,
        scope: "*",
        condition: { kind: "always" },
        action: "allow",
        words: "x",
        by: null,
        days: 10_000,
      }),
    ).rejects.toThrow(/every rule expires/);
    await expect(
      addStandingRule({
        profileId: s.profile_id,
        scope: "*",
        condition: { kind: "whenever" },
        action: "allow",
        words: "x",
        by: null,
      }),
    ).rejects.toThrow(/condition/);
    const rows = await db
      .select()
      .from(standingRules)
      .where(eq(standingRules.profile_id, s.profile_id));
    expect(rows).toHaveLength(1);
  });

  it("surfaces for renewal; an expired allow stops, an expired forbid keeps binding (D34)", () => {
    const base = {
      id: "r",
      profile_id: "p",
      scope: "meta_ads",
      condition: { kind: "always" },
      words: "",
      created_by: null,
      created_at: "2026-01-01T00:00:00Z",
      renewed_at: null,
      retired_at: null,
      expires_at: "2026-03-01T00:00:00Z",
    };
    const now = new Date("2026-04-01T00:00:00Z");
    const allow = { ...base, action: "allow" as const };
    const forbid = { ...base, action: "forbid" as const };
    expect(ruleApplies(allow, now)).toBe(false);
    expect(ruleApplies(forbid, now)).toBe(true);
    expect(dueForRenewal([allow, forbid], now)).toHaveLength(2);
    expect(rulesVerdict([allow, forbid], { capability: "meta_ads" }, now).action).toBe("forbid");
    expect(rulesVerdict([allow], { capability: "google_ads" }, now).action).toBe("none");
  });
});

function ids(s: { profile_id: string; account_id: string }) {
  return { profileId: s.profile_id, accountId: s.account_id };
}

describe("§11.2 — a failed connector demotes what depended on it", () => {
  it("capabilities no longer measured drop to station 1, and the owner is told", async () => {
    const { demoteOnConnectorFailure } = await import("./connector-health");
    const s = await fresh({ measured: true });
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(3);
    // Its only revenue source fails.
    await db
      .update(connections)
      .set({ status: "failed" })
      .where(eq(connections.account_id, s.account_id));
    const demoted = await demoteOnConnectorFailure({
      accountId: s.account_id,
      provider: "fixture",
    });
    expect(demoted).toContain("meta_ads");
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(1);
    // Review replies are measured by what they log, not a connector: untouched.
    expect(demoted).not.toContain("google_business_reviews");
    const notices = await db
      .select()
      .from(ownerNotices)
      .where(
        and(eq(ownerNotices.profile_id, s.profile_id), eq(ownerNotices.kind, "connector_demotion")),
      );
    expect(notices).toHaveLength(1);
  });
});

describe("D38 — quiet times on the business's own clock", () => {
  const base = {
    ...CAPS,
    blackout_windows: [] as Caps["blackout_windows"],
    profile_id: "x",
    capability: "meta_ads",
    set_by: null,
  } as unknown as Caps;
  const facts = { amount: money(1_000, "EUR"), targets: [] };
  const day = { actions: 0, spend_moved_minor: 0 };

  it("a weekday's quiet hours are the business's local hours, not UTC's", () => {
    // Saturday 22:00–24:00 in Budapest; 21:30Z on Sat 2026-11-14 is 22:30 there (CET, UTC+1).
    const caps = {
      ...base,
      blackout_windows: [{ weekday: 6, from_hour: 22, to_hour: 24 }],
    } as Caps;
    const at = new Date("2026-11-14T21:30:00Z");
    expect(checkCaps(caps, facts, day, at, "Europe/Budapest").verdict).toBe("refused");
    // Read in UTC it is 21:30, outside the window: no zone known, the old reading.
    expect(checkCaps(caps, facts, day, at, null).verdict).not.toBe("refused");
  });

  it("a quiet date range is the business's local date", () => {
    // 23:30Z on 23 Dec is already 24 Dec in Budapest.
    const caps = { ...base, blackout_windows: [{ from: "2026-12-24", to: "2026-12-26" }] } as Caps;
    const at = new Date("2026-12-23T23:30:00Z");
    expect(checkCaps(caps, facts, day, at, "Europe/Budapest").verdict).toBe("refused");
    expect(checkCaps(caps, facts, day, at, null).verdict).not.toBe("refused");
  });

  it("the local clock and the start of the business's day", () => {
    expect(localClock(new Date("2026-11-14T23:30:00Z"), "Europe/Budapest")).toEqual({
      day: "2026-11-15",
      weekday: 0,
      hour: 0,
    });
    expect(localClock(new Date("2026-11-14T23:30:00Z"), "Not/AZone").day).toBe("2026-11-14");
    expect(dayStart(new Date("2026-11-14T23:30:00Z"), "Europe/Budapest")).toBe(
      "2026-11-14T23:00:00.000Z",
    );
    expect(dayStart(new Date("2026-11-14T23:30:00Z"), null)).toBe("2026-11-14T00:00:00.000Z");
  });
});
