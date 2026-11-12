// The Trust Ladder — architecture-v2 D2, D9 and invariant I6. Against the
// real database, through the real stop (lib/execution/engine's
// haltExecutions), because I6 is a promise about what pressing stop does.

import "dotenv/config";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  executionHalts,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { haltExecutions, resumeExecutions } from "../execution/engine";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { bootstrapIntake } from "../intake/service";
import { createProposal } from "../proposals/service";
import {
  DEFAULT_STATION,
  LadderError,
  authorize,
  promotionEligibility,
  recordOutcome,
  setStation,
  stationOf,
} from "./ladder";

const CAPABILITIES = Object.keys(EXECUTION_SCOPE_REGISTRY);
const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function pendingProposal(profileId: string) {
  return createProposal({
    profile_id: profileId,
    module: "diagnosis",
    action: { kind: "operations_change", summary: "fixture action" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(executionHalts).where(eq(executionHalts.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  // capability_stations cascade with the profile; ladder_events stay (append-only).
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("authorize — stations to states (D2)", () => {
  it("with nothing recorded, every capability is at station 3: NEEDS_APPROVAL, today's behaviour", async () => {
    const s = await fresh();
    expect(DEFAULT_STATION).toBe(3);
    for (const capability of CAPABILITIES) {
      expect(await authorize(s.profile_id, capability)).toEqual({
        state: "NEEDS_APPROVAL",
        station: 3,
      });
    }
  });

  it("maps 1 → BLOCKED and 2 → SHADOW", async () => {
    const s = await fresh();
    // Lowering needs no evidence; raising does (the v1 spec §4.3, lib/ladder/promotion).
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null });
    expect((await authorize(s.profile_id, "fixture")).state).toBe("SHADOW");
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 1, by: null });
    expect((await authorize(s.profile_id, "fixture")).state).toBe("BLOCKED");
    await expect(
      setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null }),
    ).rejects.toThrow(/ledger's evidence/);
    // Another capability is untouched.
    expect((await authorize(s.profile_id, "meta_ads")).state).toBe("NEEDS_APPROVAL");
  });

  it("refuses station 4 without its caps and a separate confirmation, and stations outside 1–4", async () => {
    const s = await fresh();
    await expect(
      setStation({ profileId: s.profile_id, capability: "fixture", station: 4, by: null }),
    ).rejects.toBeInstanceOf(LadderError);
    await expect(
      setStation({ profileId: s.profile_id, capability: "fixture", station: 0, by: null }),
    ).rejects.toBeInstanceOf(LadderError);
    expect(await stationOf(s.profile_id, "fixture")).toBe(3);
  });

  it("the old eligibility counter points to the v1 rules, with the outcomes it has", async () => {
    const s = await fresh();
    await recordOutcome({
      profileId: s.profile_id,
      capability: "fixture",
      measurementId: crypto.randomUUID(),
      outcome: { verified: true, euro_minor: 1_000, currency: "EUR", grade: "A" },
    });
    await recordOutcome({
      profileId: s.profile_id,
      capability: "fixture",
      measurementId: crypto.randomUUID(),
      outcome: { verified: false, euro_minor: null, currency: null, grade: null },
    });
    expect(await promotionEligibility(s.profile_id, "fixture")).toEqual({
      eligible: false,
      reason: expect.stringMatching(/superseded by the v1 spec §4.3/),
      outcomes: { total: 2, verified: 1 },
    });
  });

  it("the audit trail is append-only, like the ledger", async () => {
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null });
    let message = "no error";
    try {
      await db.execute(sql`delete from ladder_events where profile_id = ${s.profile_id}`);
    } catch (error) {
      message = (error as { cause?: { message?: string } }).cause?.message ?? String(error);
    }
    expect(message).toMatch(/ladder_events is append-only: DELETE is not permitted/);
  });
});

describe("I6 — the emergency stop", () => {
  it("sets every capability to station 1 within one second and cancels pending approvals", async () => {
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null });
    const pending = await pendingProposal(s.profile_id);

    const started = performance.now();
    await haltExecutions({ accountId: s.account_id });
    const tookMs = performance.now() - started;

    expect(tookMs).toBeLessThan(1_000);
    for (const capability of CAPABILITIES) {
      expect(await authorize(s.profile_id, capability)).toEqual({ state: "BLOCKED", station: 1 });
    }
    const [row] = await db.select().from(proposals).where(eq(proposals.id, pending.id));
    expect(row?.status).toBe("expired");
  });

  it("nothing can be raised while the stop is on", async () => {
    const s = await fresh();
    await haltExecutions({ accountId: s.account_id });
    await expect(
      setStation({ profileId: s.profile_id, capability: "fixture", station: 3, by: null }),
    ).rejects.toThrow(/emergency stop is on/);
  });

  it("D9: a resume puts every station back; cancelled proposals stay cancelled", async () => {
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null });
    const pending = await pendingProposal(s.profile_id);
    await haltExecutions({ accountId: s.account_id });
    // A second press changes nothing it already changed — and loses nothing.
    await haltExecutions({ accountId: s.account_id });
    await resumeExecutions(s.account_id, null);

    expect(await stationOf(s.profile_id, "fixture")).toBe(2);
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(3);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, pending.id));
    expect(row?.status).toBe("expired");
  });
});
