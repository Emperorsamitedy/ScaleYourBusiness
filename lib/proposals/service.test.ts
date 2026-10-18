// P3-02 — every proposal event exists in the same transaction as its
// decision-log entry, transitions are guarded by the database, and the
// stored hashes make later tampering detectable.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  decisionLog,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import {
  approveProposal,
  createProposal,
  hashProposalPayload,
  ProposalError,
  recordExecution,
  rejectProposal,
  requestChanges,
  proposalQueue,
} from "./service";

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
      email: `p3-02-${crypto.randomUUID()}@test.local`,
      display_name: "P3-02 decider",
      role: "owner",
    })
    .returning({ id: users.id });
  if (!u) throw new Error("could not create test user");
  return u.id;
}

const scenario: ScenarioBlock = {
  assumptions: [],
  base_case: { case: "base", statement: "test", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "test", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "test", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — test fixture",
};

function draft(profileId: string, hours = 24) {
  return {
    profile_id: profileId,
    module: "diagnosis",
    action: { kind: "price_change", summary: "raise the test offer's price" },
    scenario,
    reversibility: { level: "easy" as const, if_you_change_your_mind: "change it back" },
    expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
  };
}

async function logEntries(refId: string) {
  return db
    .select({ kind: decisionLog.kind, actor: decisionLog.actor, hash: decisionLog.payload_hash })
    .from(decisionLog)
    .where(eq(decisionLog.ref_id, refId));
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    // Decision-log rows stay: the append-only trigger refuses deletes
    // (rule 7), and — like every other test touching the log — orphaned
    // entries in the local test database are the accepted cost.
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

describe("P3-02 — proposal events and the decision log", () => {
  it("creating a proposal writes the row and its 'proposal' log entry atomically", async () => {
    const s = await fresh();
    const row = await createProposal(draft(s.profile_id));
    expect(row.status).toBe("pending");
    const entries = await logEntries(row.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "proposal", actor: "system" });
  });

  it("a proposal born blocked is logged too — restraint is on the record (rule 14)", async () => {
    const s = await fresh();
    const row = await createProposal({
      ...draft(s.profile_id),
      blocked_by_limit: "13.5: never discount",
    });
    expect(row.status).toBe("blocked");
    const entries = await logEntries(row.id);
    expect(entries.map((e) => e.kind)).toEqual(["proposal"]);
  });

  it("approval: pending → approved by a named human, with an 'approval' entry", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    const approved = await approveProposal({ proposalId: row.id, userId });
    expect(approved.status).toBe("approved");
    expect(approved.decided_by).toBe(userId);
    const kinds = (await logEntries(row.id)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["approval", "proposal"]);
  });

  it("rejection requires a reason and records it", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await expect(rejectProposal({ proposalId: row.id, userId, reason: "  " })).rejects.toThrow(
      ProposalError,
    );
    const rejected = await rejectProposal({
      proposalId: row.id,
      userId,
      reason: "we never do video",
    });
    expect(rejected.rejection_reason).toBe("we never do video");
    const kinds = (await logEntries(row.id)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["proposal", "rejection"]);
  });

  it("a decided proposal cannot be decided again — the database is the arbiter", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await approveProposal({ proposalId: row.id, userId });
    await expect(rejectProposal({ proposalId: row.id, userId, reason: "late" })).rejects.toThrow(
      /already approved/,
    );
  });

  it("an expired window refuses the decision and says so", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id, -1)); // expired an hour ago
    await expect(approveProposal({ proposalId: row.id, userId })).rejects.toThrow(/expired/);
  });

  it("execution: approved → executed with an 'execution' entry; anything else refuses", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await expect(recordExecution({ proposalId: row.id, result: { ok: true } })).rejects.toThrow(
      /only an approved proposal/,
    );
    await approveProposal({ proposalId: row.id, userId });
    const executed = await recordExecution({ proposalId: row.id, result: { ok: true } });
    expect(executed.status).toBe("executed");
    const kinds = (await logEntries(row.id)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["approval", "execution", "proposal"]);
  });

  it("the stored hash matches a recomputation from the row — tampering is detectable", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    const approved = await approveProposal({ proposalId: row.id, userId });
    const [entry] = await db
      .select({ hash: decisionLog.payload_hash })
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, row.id), eq(decisionLog.kind, "approval")));
    const recomputed = hashProposalPayload("approval", {
      proposal_id: approved.id,
      profile_id: approved.profile_id,
      status: approved.status,
      decided_by: approved.decided_by,
      rejection_reason: approved.rejection_reason,
    });
    expect(entry?.hash).toBe(recomputed);
    // And a tampered payload no longer matches.
    const tampered = hashProposalPayload("approval", {
      proposal_id: approved.id,
      profile_id: approved.profile_id,
      status: approved.status,
      decided_by: crypto.randomUUID(),
      rejection_reason: approved.rejection_reason,
    });
    expect(entry?.hash).not.toBe(tampered);
  });
});

describe("request changes — the queue's third answer", () => {
  it("pending → changes_requested by a named human, with the words and a 'change_request' entry", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    const asked = await requestChanges({
      proposalId: row.id,
      userId,
      words: "  only the loyal customers, and no discount  ",
    });
    expect(asked.status).toBe("changes_requested");
    expect(asked.decided_by).toBe(userId);
    expect(asked.change_request).toBe("only the loyal customers, and no discount");
    expect(asked.rejection_reason).toBeNull();
    expect(asked.execute_not_before).toBeNull();
    const entries = await logEntries(row.id);
    expect(entries.map((e) => e.kind).sort()).toEqual(["change_request", "proposal"]);
    // The owner's words are in the hashed payload — editing them later is detectable.
    const entry = entries.find((e) => e.kind === "change_request");
    expect(entry?.hash).toBe(
      hashProposalPayload("change_request", {
        proposal_id: asked.id,
        profile_id: asked.profile_id,
        status: asked.status,
        decided_by: asked.decided_by,
        rejection_reason: null,
        detail: { change_request: asked.change_request },
      }),
    );
    // It lands in history, not pending — and it can't then be approved.
    const queue = await proposalQueue(s.profile_id);
    expect(queue.pending.map((p) => p.id)).not.toContain(row.id);
    expect(queue.decided.map((p) => p.id)).toContain(row.id);
    await expect(approveProposal({ proposalId: row.id, userId })).rejects.toThrow(
      /already changes_requested/,
    );
  });

  it("asking for changes without saying what refuses, and records nothing", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await expect(requestChanges({ proposalId: row.id, userId, words: "   " })).rejects.toThrow(
      ProposalError,
    );
    const [cur] = await db.select().from(proposals).where(eq(proposals.id, row.id));
    expect(cur?.status).toBe("pending");
    expect((await logEntries(row.id)).map((e) => e.kind)).toEqual(["proposal"]);
  });

  it("the database refuses a changes_requested row without the owner's words", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await expect(
      db
        .update(proposals)
        .set({
          status: "changes_requested",
          decided_by: userId,
          decided_at: new Date().toISOString(),
        })
        .where(eq(proposals.id, row.id)),
    ).rejects.toThrow();
  });

  it("an already-decided proposal cannot be sent back for changes", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const row = await createProposal(draft(s.profile_id));
    await rejectProposal({ proposalId: row.id, userId, reason: "no" });
    await expect(
      requestChanges({ proposalId: row.id, userId, words: "try again smaller" }),
    ).rejects.toThrow(/already rejected/);
  });
});

describe("P3-06 — expiry and the queue", () => {
  it("the sweep expires only due pending proposals, and the queue never mixes expired with rejected", async () => {
    const s = await fresh();
    const userId = await decider(s.account_id);
    const due = await createProposal(draft(s.profile_id, -1)); // past
    const alive = await createProposal(draft(s.profile_id, 24)); // future
    const rejected = await createProposal(draft(s.profile_id, 24));
    await rejectProposal({ proposalId: rejected.id, userId, reason: "no" });
    const blocked = await createProposal({
      ...draft(s.profile_id),
      blocked_by_limit: "13.5: never discount",
    });

    const queue = await proposalQueue(s.profile_id);
    expect(queue.expired.map((p) => p.id)).toEqual([due.id]);
    expect(queue.pending.map((p) => p.id)).toEqual([alive.id]);
    expect(queue.blocked.map((p) => p.id)).toEqual([blocked.id]);
    expect(queue.decided.map((p) => p.id)).toEqual([rejected.id]);
    // Expired stayed undecided; rejected carries its decider and reason.
    expect(queue.expired[0]?.decided_by).toBeNull();
    expect(queue.decided[0]?.rejection_reason).toBe("no");
  });
});
