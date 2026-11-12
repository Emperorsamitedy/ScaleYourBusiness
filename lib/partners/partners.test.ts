// The Partner Console — the v1 build spec §7.7's acceptance criteria and the
// Phase 6 gate: no partner access without an active mandate (enforced in the
// database), revocation that cuts access at once and keeps the trail, partner
// actions in the owner's audit trail by name, a 200-client book under two
// seconds, commentary that survives a re-run, and 40 clients onboarded in
// one session.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  decisionLog,
  diagnosisReports,
  fieldRecords,
  firmCommentary,
  firmMembers,
  firmMetricRollups,
  firms,
  leaks,
  mandateRequests,
  mandates,
  offers,
  profileSnapshots,
  proposals,
  snapshotRecords,
  users,
} from "../../db/schema";
import { createOwner } from "../auth/service";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { DiagnosisLlm } from "../diagnosis/findings";
import type { RecommendationsLlm } from "../diagnosis/recommendations";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { createProposal } from "../proposals/service";
import { generateReport } from "../report/service";
import { PartnerAccessError, partnerClients, partnerMay } from "./access";
import { approveForClient, nudgeClient, whiteLabelReport, writeCommentary } from "./actions";
import { bookView, firmRollup } from "./book";
import { addMember, createFirm, firmTierFor } from "./firm";
import type { MandateEmail } from "./mandates";
import {
  grantByToken,
  grantMandate,
  importClients,
  requestByToken,
  revokeMandate,
} from "./mandates";

const profiles: string[] = [];
const accountIds: string[] = [];
const firmIds: string[] = [];

afterAll(async () => {
  if (firmIds.length > 0) {
    await db.delete(firmCommentary).where(inArray(firmCommentary.firm_id, firmIds));
    await db.delete(mandateRequests).where(inArray(mandateRequests.firm_id, firmIds));
    await db.delete(firmMetricRollups).where(inArray(firmMetricRollups.firm_id, firmIds));
    await db.delete(mandates).where(inArray(mandates.firm_id, firmIds));
    await db.delete(firmMembers).where(inArray(firmMembers.firm_id, firmIds));
    await db.delete(firms).where(inArray(firms.id, firmIds));
  }
  if (profiles.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, profiles));
    await db.delete(leaks).where(inArray(leaks.profile_id, profiles));
    await db.delete(diagnosisReports).where(inArray(diagnosisReports.profile_id, profiles));
    const snaps = await db
      .select({ id: profileSnapshots.id })
      .from(profileSnapshots)
      .where(inArray(profileSnapshots.profile_id, profiles));
    if (snaps.length > 0)
      await db.delete(snapshotRecords).where(
        inArray(
          snapshotRecords.snapshot_id,
          snaps.map((s) => s.id),
        ),
      );
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, profiles));
    await db.delete(offers).where(inArray(offers.profile_id, profiles));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profiles));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profiles));
  }
  if (accountIds.length > 0) {
    await db.update(accounts).set({ owner_user_id: null }).where(inArray(accounts.id, accountIds));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

/** A business with its owner, as a signed-up client. */
async function client(email = `owner-${randomUUID()}@example.test`) {
  const s = await bootstrapIntake();
  profiles.push(s.profile_id);
  accountIds.push(s.account_id);
  const owner = await createOwner(s.account_id, email);
  return { ...s, owner };
}

/** A person at a firm (a SYB user with their own account), and the firm. */
async function partner(role: "principal" | "manager" | "staff" = "principal", firmId?: string) {
  const c = await client(`partner-${randomUUID()}@example.test`);
  if (!firmId) {
    const firm = await createFirm({
      userId: c.owner.id,
      name: "Kovács & Társa",
      country: "HU",
      type: "accountancy",
    });
    firmIds.push(firm.id);
    return { user: c.owner, firm };
  }
  await db.insert(firmMembers).values({ firm_id: firmId, user_id: c.owner.id, role });
  return { user: c.owner, firm: { id: firmId } };
}

const ALL = ["read_diagnosis", "approve_actions", "manage_connectors", "receive_reports"];

describe("§7.7 — no partner reaches a business without an active mandate, in the database", () => {
  it("no mandate, wrong scope, expired or another firm: no access; a live mandate in scope: access", async () => {
    const p = await partner();
    const outsider = await partner();
    const c = await client();
    expect(await partnerMay(p.user.id, c.profile_id, "read_diagnosis")).toBe(false);
    await expect(
      whiteLabelReport({ userId: p.user.id, profileId: c.profile_id }),
    ).rejects.toBeInstanceOf(PartnerAccessError);

    await grantMandate({
      ownerUserId: c.owner.id,
      profileId: c.profile_id,
      firmId: p.firm.id,
      scopes: ["read_diagnosis"],
      evidenceRef: "EL-2026-001",
    });
    expect(await partnerMay(p.user.id, c.profile_id, "read_diagnosis")).toBe(true);
    expect(await partnerMay(p.user.id, c.profile_id, "approve_actions")).toBe(false);
    expect(await partnerMay(outsider.user.id, c.profile_id, "read_diagnosis")).toBe(false);
    expect(await partnerClients(p.user.id, "read_diagnosis")).toEqual([c.profile_id]);
    expect(await partnerClients(outsider.user.id, "read_diagnosis")).toEqual([]);

    // An expired mandate (granted long ago for a month) counts for nothing.
    const old = await client();
    await grantMandate({
      ownerUserId: old.owner.id,
      profileId: old.profile_id,
      firmId: p.firm.id,
      scopes: ALL,
      months: 1,
      evidenceRef: "EL-old",
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(await partnerMay(p.user.id, old.profile_id, "read_diagnosis")).toBe(false);

    // The check is the database's: asked directly, it says the same.
    const direct = await db.execute<{ ok: boolean }>(
      sql`select partner_may(${p.user.id}::uuid, ${old.profile_id}::uuid, 'read_diagnosis') as ok`,
    );
    expect(direct.rows[0]?.ok).toBe(false);
  });

  it("a mandate needs scopes and an engagement letter", async () => {
    const p = await partner();
    const c = await client();
    await expect(
      grantMandate({
        ownerUserId: c.owner.id,
        profileId: c.profile_id,
        firmId: p.firm.id,
        scopes: [],
        evidenceRef: "x",
      }),
    ).rejects.toThrow(/at least one/);
    await expect(
      grantMandate({
        ownerUserId: c.owner.id,
        profileId: c.profile_id,
        firmId: p.firm.id,
        scopes: ALL,
        evidenceRef: "  ",
      }),
    ).rejects.toThrow(/engagement letter/);
  });
});

describe("§7.7 — revoking cuts access at once and leaves the trail intact", () => {
  it("revoked: the next check says no; the row stays; it can't be edited or un-revoked; both are in the owner's log", async () => {
    const p = await partner();
    const c = await client();
    const m = await grantMandate({
      ownerUserId: c.owner.id,
      profileId: c.profile_id,
      firmId: p.firm.id,
      scopes: ALL,
      evidenceRef: "EL-7",
    });
    expect(await partnerMay(p.user.id, c.profile_id, "read_diagnosis")).toBe(true);
    const started = Date.now();
    await revokeMandate({ ownerUserId: c.owner.id, profileId: c.profile_id, mandateId: m.id });
    expect(await partnerMay(p.user.id, c.profile_id, "read_diagnosis")).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);

    const [row] = await db.select().from(mandates).where(eq(mandates.id, m.id));
    expect(row?.revoked_at).not.toBeNull();
    const refused = (q: Promise<unknown>) =>
      q.then(
        () => "updated",
        (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
      );
    expect(
      await refused(db.update(mandates).set({ revoked_at: null }).where(eq(mandates.id, m.id))),
    ).toMatch(/only ever gets revoked/);
    expect(
      await refused(
        db
          .update(mandates)
          .set({ scopes: ["read_diagnosis"] })
          .where(eq(mandates.id, m.id)),
      ),
    ).toMatch(/only ever gets revoked/);

    const log = await db.select().from(decisionLog).where(eq(decisionLog.profile_id, c.profile_id));
    expect(log.map((l) => [l.kind, l.actor, l.user_id])).toEqual(
      expect.arrayContaining([
        ["mandate_grant", "owner", c.owner.id],
        ["mandate_revoke", "owner", c.owner.id],
      ]),
    );
  });
});

describe("§7.7 — a partner action is in the owner's audit trail with the partner's name", () => {
  it("approving, commenting and nudging write the partner's own entries", async () => {
    const p = await partner();
    const staff = await partner("staff", p.firm.id);
    const c = await client();
    await grantMandate({
      ownerUserId: c.owner.id,
      profileId: c.profile_id,
      firmId: p.firm.id,
      scopes: ALL,
      evidenceRef: "EL-9",
    });
    const proposal = await createProposal({
      profile_id: c.profile_id,
      module: "diagnosis",
      action: { kind: "operations_change", summary: "Raise the coffee price by 20 cents" },
      scenario: {} as never,
      reversibility: { level: "easy", if_you_change_your_mind: "undo" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await approveForClient({ userId: p.user.id, profileId: c.profile_id, proposalId: proposal.id });
    // Staff may comment but not approve.
    await expect(
      approveForClient({ userId: staff.user.id, profileId: c.profile_id, proposalId: proposal.id }),
    ).rejects.toThrow(/role/);
    await writeCommentary({
      userId: staff.user.id,
      profileId: c.profile_id,
      section: "summary",
      body: "We'll go through this at the next meeting.",
    });
    await nudgeClient({ userId: p.user.id, profileId: c.profile_id, what: "your till" });

    const log = await db
      .select({
        kind: decisionLog.kind,
        actor: decisionLog.actor,
        user_id: decisionLog.user_id,
        ref: decisionLog.ref_id,
        name: users.display_name,
      })
      .from(decisionLog)
      .innerJoin(users, eq(users.id, decisionLog.user_id))
      .where(and(eq(decisionLog.profile_id, c.profile_id), eq(decisionLog.actor, "partner")));
    expect(log.map((l) => [l.kind, l.user_id])).toEqual(
      expect.arrayContaining([
        ["approval", p.user.id],
        ["partner_action", p.user.id],
        ["partner_action", staff.user.id],
      ]),
    );
    expect(log.every((l) => l.name !== "")).toBe(true);
    // The firm stays readable on every partner_action entry.
    expect(
      log.filter((l) => l.kind === "partner_action").every((l) => l.ref.includes(p.firm.id)),
    ).toBe(true);
    const [decided] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(decided).toMatchObject({ status: "approved", decided_by: p.user.id });
  });
});

describe("§7.3 — white-label commentary survives a diagnosis re-run", { timeout: 120_000 }, () => {
  it("the firm's words stay on their section across report versions, kept apart from SYB's", async () => {
    await loadBank("specs/question-bank-v1.json");
    const p = await partner();
    const c = await client();
    const [offer] = await db
      .insert(offers)
      .values({ profile_id: c.profile_id, kind: "physical" })
      .returning();
    const write = (key: string, value: unknown) =>
      writeField(
        c.profile_id,
        createField<unknown>({
          id: fieldId(key),
          value,
          status: "answered",
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: isoDateTime(new Date().toISOString()),
          recorded_at: isoDateTime(new Date().toISOString()),
        }),
      );
    await write(`offers.${offer!.id}.name`, "Coffee");
    await write(`offers.${offer!.id}.price`, { amount_minor: 300, currency: "EUR" });
    await write(`offers.${offer!.id}.cost_to_deliver`, { amount_minor: 250, currency: "EUR" });
    await write(`offers.${offer!.id}.volume_period`, 400);
    const findingsLlm: DiagnosisLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          summary: "Margin is thin.",
          findings: [
            {
              area: "finance",
              title: "Thin margin",
              detail: "Price and cost sit close.",
              evidence: [`offers.${offer!.id}.price`],
              severity: "high",
              confidence: 0.8,
            },
          ],
        }),
        calls: [],
      });
    const recommendationsLlm: RecommendationsLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          recommendations: [
            {
              addresses: [0],
              title: "Test a 10% price rise",
              rationale: "Thin margin.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "Set the price back.",
              scenario: {
                kind: "price_change",
                offer_id: offer!.id,
                change_pct: 10,
                volume_response_base_pct: -5,
                volume_response_downside_pct: -20,
                volume_response_upside_pct: 0,
                gap_field_keys: null,
                gap_why: null,
              },
            },
          ],
        }),
        calls: [],
      });
    await generateReport({
      accountId: c.account_id,
      profileId: c.profile_id,
      findingsLlm,
      recommendationsLlm,
    });

    await grantMandate({
      ownerUserId: c.owner.id,
      profileId: c.profile_id,
      firmId: p.firm.id,
      scopes: ALL,
      evidenceRef: "EL-11",
    });
    await writeCommentary({
      userId: p.user.id,
      profileId: c.profile_id,
      section: "findings",
      body: "Agree: prices first.",
    });
    const before = await whiteLabelReport({ userId: p.user.id, profileId: c.profile_id });
    expect(before.commentary.findings).toBe("Agree: prices first.");
    expect(before.firm.name).toBe("Kovács & Társa");

    // A re-run: a fact changes, a new report version is written.
    await write(`offers.${offer!.id}.price`, { amount_minor: 320, currency: "EUR" });
    await generateReport({
      accountId: c.account_id,
      profileId: c.profile_id,
      findingsLlm,
      recommendationsLlm,
    });
    const after = await whiteLabelReport({ userId: p.user.id, profileId: c.profile_id });
    expect(after.report?.version).toBe(2);
    expect(after.commentary.findings).toBe("Agree: prices first.");
    // An edit supersedes; the old words are kept.
    await writeCommentary({
      userId: p.user.id,
      profileId: c.profile_id,
      section: "findings",
      body: "Prices first, then stock.",
    });
    const all = await db
      .select()
      .from(firmCommentary)
      .where(eq(firmCommentary.profile_id, c.profile_id));
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.superseded_at === null).map((r) => r.body)).toEqual([
      "Prices first, then stock.",
    ]);
  });
});

describe(
  "§7.2 / §7.7 — the book view: 200 clients under two seconds, biggest leak first",
  { timeout: 120_000 },
  () => {
    it("lists only mandated clients, sorted by open leak size, in under two seconds", async () => {
      const p = await partner();
      // 200 client businesses, seeded in bulk.
      const acc = await db
        .insert(accounts)
        .values(Array.from({ length: 200 }, () => ({ reporting_currency: "EUR", locale: "en-GB" })))
        .returning({ id: accounts.id });
      accountIds.push(...acc.map((a) => a.id));
      const prof = await db
        .insert(businessProfiles)
        .values(acc.map((a) => ({ account_id: a.id, schema_version: "1.0.0" })))
        .returning({ id: businessProfiles.id });
      profiles.push(...prof.map((x) => x.id));
      await db.insert(mandates).values(
        prof.map((x) => ({
          firm_id: p.firm.id,
          profile_id: x.id,
          scopes: ["read_diagnosis"],
          granted_by_user_id: p.user.id,
          expires_at: new Date(Date.now() + 86_400_000 * 30).toISOString(),
          evidence_ref: "EL-bulk",
        })),
      );
      // Three clients with open leaks of different sizes.
      await db.insert(leaks).values([
        {
          profile_id: prof[10]!.id,
          key: "a",
          title: "Small",
          currency: "EUR",
          low_minor: 1_000,
          high_minor: 2_000,
          grade: "B",
        },
        {
          profile_id: prof[20]!.id,
          key: "b",
          title: "Big",
          currency: "EUR",
          low_minor: 50_000,
          high_minor: 90_000,
          grade: "B",
        },
        {
          profile_id: prof[30]!.id,
          key: "c",
          title: "Middle",
          currency: "EUR",
          low_minor: 10_000,
          high_minor: 20_000,
          grade: "B",
        },
      ]);
      const outsider = await client(); // not mandated: never in the book
      const started = Date.now();
      const book = await bookView(p.user.id);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(book).toHaveLength(200);
      expect(book.map((r) => r.profile_id)).not.toContain(outsider.profile_id);
      expect(book.slice(0, 3).map((r) => r.largest_leak?.title)).toEqual([
        "Big",
        "Middle",
        "Small",
      ]);
      // No report yet means no grade: the money stays hidden (§6.2).
      expect(book[0]!.leaks_money).toEqual([]);

      const rollup = await firmRollup(p.firm.id, p.user.id);
      expect(rollup).toMatchObject({ clients_active: 200, leaks_open: 3 });
      expect(firmTierFor(200)).toEqual({ tier: "partner_network", rev_share_bp: 2_500 });
      expect(firmTierFor(10)).toEqual({ tier: "partner_starter", rev_share_bp: 1_500 });
      expect(firmTierFor(11)).toEqual({ tier: "partner_practice", rev_share_bp: 2_000 });
    });
  },
);

describe("§7.6 — bulk onboarding: 40 clients in one session", { timeout: 120_000 }, () => {
  it("one CSV asks 40 clients in their own language; a client grants with no SYB account of their own", async () => {
    const p = await partner();
    const sent: MandateEmail[] = [];
    const csv = [
      "Business,Email,Country,Language",
      ...Array.from(
        { length: 40 },
        (_, i) =>
          `Client ${i},client${i}-${randomUUID().slice(0, 6)}@example.test,HU,${i % 2 ? "hu-HU" : "en"}`,
      ),
      "No email,,HU,en",
    ].join("\n");
    const started = Date.now();
    const out = await importClients({
      userId: p.user.id,
      csv,
      scopes: ALL,
      evidenceRef: "EL-batch-2026-11",
      appUrl: "https://app.test",
      mailer: async (m) => {
        sent.push(m);
        return "sent";
      },
    });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(out).toMatchObject({
      requested: 40,
      emails: { sent: 40, not_configured: 0, failed: 0 },
    });
    expect(out.skipped).toEqual([{ row: 42, why: "email" }]);
    expect(sent.filter((m) => m.locale === "hu-HU")).toHaveLength(20);
    // Asking the same clients again doesn't ask twice.
    const again = await importClients({
      userId: p.user.id,
      csv,
      scopes: ALL,
      evidenceRef: "EL",
      appUrl: "https://app.test",
      mailer: async () => "sent",
    });
    expect(again.requested).toBe(0);

    // One client answers the email.
    const token = sent[0]!.link.split("/mandate/")[1]!;
    expect(await requestByToken(token)).not.toBeNull();
    const granted = await grantByToken(token);
    profiles.push(granted.profile_id);
    accountIds.push(granted.session.account_id);
    expect(await partnerMay(p.user.id, granted.profile_id, "approve_actions")).toBe(true);
    expect(await requestByToken(token)).toBeNull(); // used once
    await expect(grantByToken(token)).rejects.toThrow(/isn't open/);
  });

  it("a principal adds members; staff can't import", async () => {
    const p = await partner();
    const later = await client(`later-${randomUUID()}@example.test`);
    await addMember({ userId: p.user.id, email: later.owner.email, role: "staff" });
    await expect(
      importClients({
        userId: later.owner.id,
        csv: "Business,Email\nX,x@example.test",
        scopes: ALL,
        evidenceRef: "EL",
        appUrl: "https://app.test",
        mailer: async () => "sent",
      }),
    ).rejects.toThrow(/role/);
    await expect(
      addMember({ userId: p.user.id, email: "nobody@example.test", role: "staff" }),
    ).rejects.toThrow(/sign in/);
  });
});
