// P3-01 — the proposals table's invariants, held by the DATABASE.
// Every rule gets a passing and a failing case (CLAUDE.md convention):
// the failing insert must be refused by Postgres itself, so no future
// service code can quietly relax rule 12 or rule 14.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

async function decider(accountId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      account_id: accountId,
      email: `p3-01-${crypto.randomUUID()}@test.local`,
      display_name: "P3-01 decider",
      role: "owner",
    })
    .returning({ id: users.id });
  if (!u) throw new Error("could not create test user");
  return u.id;
}

/**
 * Assert Postgres refused the insert on the named constraint. Drizzle
 * wraps the pg error ("Failed query: …"); the constraint name is on the
 * cause, so a plain rejects.toThrow(/name/) never sees it.
 */
async function refusedBy(p: Promise<unknown>, constraint: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { constraint?: string; message?: string } }).cause;
    expect(`${cause?.constraint ?? ""} ${cause?.message ?? ""}`).toContain(constraint);
    return;
  }
  expect.fail(`insert was accepted — expected ${constraint} to refuse it`);
}

/** The smallest structurally honest proposal row. */
function base(profileId: string) {
  return {
    profile_id: profileId,
    module: "diagnosis",
    action: { kind: "test", summary: "raise the price of the test offer" },
    scenario: { assumptions: [], breakeven_condition: "none — test fixture" },
    reversibility: { level: "easy", if_you_change_your_mind: "change it back" },
    expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  };
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-01 — proposals table invariants", () => {
  it("accepts a well-formed pending proposal (all rules, passing case)", async () => {
    const s = await fresh();
    const [row] = await db.insert(proposals).values(base(s.profile_id)).returning();
    expect(row?.status).toBe("pending");
    expect(row?.requires_approval).toBe(true);
    expect(row?.decided_by).toBeNull();
  });

  it("rule 12: requires_approval = false is unrepresentable", async () => {
    const s = await fresh();
    await refusedBy(
      db.insert(proposals).values({ ...base(s.profile_id), requires_approval: false }),
      "proposals_requires_approval_true",
    );
  });

  it("rule 14: a blocked proposal must name the limit it hit", async () => {
    const s = await fresh();
    await refusedBy(
      db.insert(proposals).values({ ...base(s.profile_id), status: "blocked" as const }),
      "proposals_blocked_names_limit",
    );
    // Passing case: the limit named.
    const [row] = await db
      .insert(proposals)
      .values({
        ...base(s.profile_id),
        status: "blocked" as const,
        blocked_by_limit: "13.5: never discount",
      })
      .returning();
    expect(row?.status).toBe("blocked");
  });

  it("rule 12: approval without a deciding human is unrepresentable", async () => {
    const s = await fresh();
    await refusedBy(
      db.insert(proposals).values({
        ...base(s.profile_id),
        status: "approved" as const,
        decided_at: new Date().toISOString(),
      }),
      "proposals_decided_by_human",
    );
    // Passing case: a real user id and timestamp.
    const userId = await decider(s.account_id);
    const [row] = await db
      .insert(proposals)
      .values({
        ...base(s.profile_id),
        status: "approved" as const,
        decided_by: userId,
        decided_at: new Date().toISOString(),
      })
      .returning();
    expect(row?.decided_by).toBe(userId);
  });

  it("a rejection must carry its reason", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const decided = {
      status: "rejected" as const,
      decided_by: userId,
      decided_at: new Date().toISOString(),
    };
    await refusedBy(
      db.insert(proposals).values({ ...base(s.profile_id), ...decided }),
      "proposals_rejection_has_reason",
    );
    const [row] = await db
      .insert(proposals)
      .values({ ...base(s.profile_id), ...decided, rejection_reason: "we never do video" })
      .returning();
    expect(row?.rejection_reason).toBe("we never do video");
  });

  it("executed demands both a decider and a result", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    await refusedBy(
      db.insert(proposals).values({
        ...base(s.profile_id),
        status: "executed" as const,
        decided_by: userId,
        decided_at: new Date().toISOString(),
      }),
      "proposals_executed_has_result",
    );
    const [row] = await db
      .insert(proposals)
      .values({
        ...base(s.profile_id),
        status: "executed" as const,
        decided_by: userId,
        decided_at: new Date().toISOString(),
        execution_result: { ok: true, at: new Date().toISOString() },
      })
      .returning();
    expect(row?.status).toBe("executed");
  });

  it("expired needs no decider — silence is not a decision (P3-06)", async () => {
    const s = await fresh();
    const [row] = await db
      .insert(proposals)
      .values({
        ...base(s.profile_id),
        status: "expired" as const,
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .returning();
    expect(row?.status).toBe("expired");
    expect(row?.decided_by).toBeNull();
  });
});
