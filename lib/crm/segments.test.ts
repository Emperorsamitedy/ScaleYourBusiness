// P4-13/14 — lifecycle as arithmetic with its thresholds tested at the
// boundaries both ways; purchase history read from the owner's own
// export, money as minor units; segments that separate WHO IS IN from
// WHO MAY BE EMAILED; and the done-when: a lapsed segment computes from
// imported data and a win-back proposal citing it renders in the queue
// — through posture, suppression and the hard limits like everything.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  decisionLog,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { proposalQueue, rejectProposal } from "../proposals/service";
import type { ContactRow } from "./contacts";
import { addContact } from "./contacts";
import { importContacts, parseCount, parseDate, parseMoneyMinor } from "./import";
import { proposeFromSegments } from "./segment-proposals";
import { LIFECYCLE, VIP, computeSegments, isVip, lifecycleOf, vipSpendFloors } from "./segments";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-10-13T12:00:00Z");
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-e-${crypto.randomUUID()}@test.local`,
      display_name: "Session E owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

async function owner(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

function contact(over: Partial<ContactRow>): ContactRow {
  return {
    id: crypto.randomUUID(),
    account_id: "a",
    email: "x@example.com",
    name: null,
    phone: null,
    consent_status: "explicit_consent",
    consent_source: "t",
    consent_captured_at: daysAgo(400),
    first_seen_at: daysAgo(400),
    last_activity_at: null,
    last_purchase_at: null,
    orders_count: null,
    total_spent_minor: null,
    spent_currency: null,
    country: null,
    purchase_refreshed_at: null,
    ...over,
  };
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  for (const s of created) {
    await db.delete(contacts).where(eq(contacts.account_id, s.account_id));
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, s.account_id));
  }
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) await db.delete(users).where(eq(users.account_id, s.account_id));
  // The decision log is append-only by trigger; test rows stay, as the log intends.
  void decisionLog;
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P4-13 — lifecycle, at the boundaries", () => {
  it("counts from the last purchase, falls back to activity, and is unknown without either", () => {
    expect(lifecycleOf(contact({ last_purchase_at: daysAgo(60) }), NOW)).toBe("active");
    expect(lifecycleOf(contact({ last_activity_at: daysAgo(60) }), NOW)).toBe("active");
    expect(lifecycleOf(contact({}), NOW)).toBe("unknown");
    // A purchase date outranks a later activity date: it is the measured one.
    expect(
      lifecycleOf(contact({ last_purchase_at: daysAgo(200), last_activity_at: daysAgo(1) }), NOW),
    ).toBe("lapsed");
  });

  it("active ↔ lapsing at exactly 90 days, lapsing ↔ lapsed at exactly 180 — both directions", () => {
    const at = (days: number) => lifecycleOf(contact({ last_purchase_at: daysAgo(days) }), NOW);
    expect(LIFECYCLE.active_days).toBe(90);
    expect(LIFECYCLE.lapsing_days).toBe(180);
    expect(at(90)).toBe("active");
    expect(at(90.001)).toBe("lapsing");
    expect(at(180)).toBe("lapsing");
    expect(at(180.001)).toBe("lapsed");
    expect(at(365)).toBe("lapsed");
  });

  it("new = only purchase within 30 days with at most one order; a second order, or an older purchase, makes them active", () => {
    expect(LIFECYCLE.new_days).toBe(30);
    expect(lifecycleOf(contact({ last_purchase_at: daysAgo(5), orders_count: 1 }), NOW)).toBe(
      "new",
    );
    expect(lifecycleOf(contact({ last_purchase_at: daysAgo(30), orders_count: null }), NOW)).toBe(
      "new",
    );
    expect(lifecycleOf(contact({ last_purchase_at: daysAgo(30.001), orders_count: 1 }), NOW)).toBe(
      "active",
    );
    expect(lifecycleOf(contact({ last_purchase_at: daysAgo(5), orders_count: 2 }), NOW)).toBe(
      "active",
    );
    // The import date is NOT the first purchase: a row imported today with a
    // purchase last year is lapsed, however fresh the row is.
    expect(
      lifecycleOf(
        contact({ first_seen_at: daysAgo(0), last_purchase_at: daysAgo(300), orders_count: 1 }),
        NOW,
      ),
    ).toBe("lapsed");
  });

  it("VIP = 3+ orders, or top tenth of spend once ten contacts carry a figure in that currency", () => {
    expect(VIP.min_orders).toBe(3);
    const small = [contact({ total_spent_minor: 100000, spent_currency: "EUR" })];
    expect(vipSpendFloors(small).size).toBe(0);
    expect(isVip(contact({ orders_count: 3 }), new Map())).toBe(true);
    expect(isVip(contact({ orders_count: 2 }), new Map())).toBe(false);

    const many = Array.from({ length: 20 }, (_, i) =>
      contact({ total_spent_minor: (i + 1) * 1000, spent_currency: "EUR" }),
    );
    const floors = vipSpendFloors(many);
    expect(floors.get("EUR")).toBe(19000); // top 2 of 20: 20 000 and 19 000
    expect(isVip(contact({ total_spent_minor: 19000, spent_currency: "EUR" }), floors)).toBe(true);
    expect(isVip(contact({ total_spent_minor: 18999, spent_currency: "EUR" }), floors)).toBe(false);
    expect(isVip(contact({ total_spent_minor: 19000, spent_currency: "HUF" }), floors)).toBe(false);
  });
});

describe("P4-13 — purchase history from the owner's export", () => {
  it("reads dates, counts and money honestly: minor units for the currency, null for what it cannot read", () => {
    expect(parseDate("2026-03-02")).toBe("2026-03-02T00:00:00.000Z");
    expect(parseDate("02.03.2026")).toBe("2026-03-02T00:00:00.000Z");
    expect(parseDate("2026-03-02T10:00:00Z")).toBe("2026-03-02T10:00:00.000Z");
    expect(parseDate("not a date")).toBeNull();
    expect(parseCount("4")).toBe(4);
    expect(parseCount("1 204")).toBe(1204);
    expect(parseCount("four")).toBeNull();
    expect(parseMoneyMinor("312.50", "EUR")).toBe(31250);
    expect(parseMoneyMinor("1,234.5", "EUR")).toBe(123450);
    expect(parseMoneyMinor("1.234,50", "EUR")).toBe(123450);
    expect(parseMoneyMinor("€ 12", "EUR")).toBe(1200);
    expect(parseMoneyMinor("12 500", "HUF")).toBe(1250000); // HUF carries fillér: exponent 2
    expect(parseMoneyMinor("12 500", "JPY")).toBe(12500); // JPY: exponent 0
    expect(parseMoneyMinor("abc", "EUR")).toBeNull();
  });

  it("imports the purchase columns, demands a currency for a spent column, and counts the unreadable", async () => {
    const s = await fresh();
    const csv = [
      "email,name,last order date,orders,total spent",
      "anna@example.com,Anna,2026-03-02,4,312.50",
      "ben@example.com,Ben,2025-01-15,1,20",
      "cara@example.com,Cara,soon,many,lots",
    ].join("\n");
    await expect(
      importContacts(s.account_id, csv, { status: "explicit_consent", statement: "test" }),
    ).rejects.toThrow(/currency/);
    const result = await importContacts(
      s.account_id,
      csv,
      { status: "explicit_consent", statement: "checkout checkbox since 2024" },
      { currency: "eur" },
    );
    expect(result.imported).toBe(3);
    expect(result.purchase).toEqual({
      columns: ["last_purchase", "orders", "spent"],
      unreadable: 3,
      refreshed: 0,
    });
    const rows = await db.select().from(contacts).where(eq(contacts.account_id, s.account_id));
    const anna = rows.find((r) => r.email === "anna@example.com")!;
    expect(anna.last_purchase_at?.slice(0, 10)).toBe("2026-03-02");
    expect(anna.orders_count).toBe(4);
    expect(anna.total_spent_minor).toBe(31250);
    expect(anna.spent_currency).toBe("EUR");
    const cara = rows.find((r) => r.email === "cara@example.com")!;
    expect(cara.last_purchase_at).toBeNull();
    expect(cara.orders_count).toBeNull();
    expect(cara.total_spent_minor).toBeNull();
    expect(cara.spent_currency).toBeNull();
  });
});

describe("P4-13/14 — segments and the win-back proposal", () => {
  it("THE DONE-WHEN: a lapsed segment computes from imported data and a win-back proposal citing it renders in the queue", async () => {
    const s = await fresh();
    await owner(s.profile_id, "customers.marketing_consent_status", "explicit_consent");
    const csv = [
      "email,name,last order date,orders,total spent",
      "lapsed1@example.com,L1,2026-01-10,2,80",
      "lapsed2@example.com,L2,2025-12-01,1,40",
      "active1@example.com,A1,2026-10-01,5,500",
    ].join("\n");
    await importContacts(
      s.account_id,
      csv,
      { status: "explicit_consent", statement: "checkout checkbox" },
      { currency: "EUR" },
    );
    // One lapsed contact WITHOUT consent: in the segment, not emailable.
    await addContact(s.account_id, {
      email: "lapsed3@example.com",
      consent: { status: "unsure", source: "old list" },
    });
    await db
      .update(contacts)
      .set({ last_purchase_at: daysAgo(300) })
      .where(eq(contacts.email, "lapsed3@example.com"));

    const report = await computeSegments(s.account_id, NOW);
    expect(report.contacts).toBe(4);
    expect(report.lifecycle).toEqual({ new: 0, active: 1, lapsing: 0, lapsed: 3, unknown: 0 });
    const lapsed = report.segments.find((x) => x.key === "lapsed")!;
    expect(lapsed.contact_ids).toHaveLength(3);
    expect(lapsed.emailable_ids).toHaveLength(2);
    expect(lapsed.excluded).toEqual({ no_email: 0, no_consent: 1, suppressed: 0 });
    expect(lapsed.evidence.join(" ")).toMatch(/more than 180 days/);
    expect(lapsed.evidence.join(" ")).toMatch(
      /3 of 4 contacts match; 2 hold explicit email consent/,
    );
    const vip = report.segments.find((x) => x.key === "vip")!;
    expect(vip.contact_ids).toHaveLength(1); // A1: 5 orders

    const out = await proposeFromSegments(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(out.created.map((p) => (p.action as { kind: string }).kind)).toEqual([
      "customer_email",
      "customer_email",
    ]);
    const winback = out.created.find((p) => p.originating_finding === "crm:winback:2026-10")!;
    const detail = (winback.action as { detail: Record<string, unknown> }).detail;
    expect(detail.segment).toBe("lapsed");
    expect(detail.contact_ids).toHaveLength(2);
    expect(detail.in_segment).toBe(3);
    expect(JSON.stringify(winback.action)).not.toContain("@example.com"); // ids only, never PII
    expect((winback.action as { summary: string }).summary).toBe(
      "Win back 2 lapsed customers who said yes to email",
    );

    const queue = await proposalQueue(s.profile_id, NOW);
    expect(queue.pending.map((p) => p.id)).toContain(winback.id);

    // Idempotent per month: the second run proposes nothing and says why.
    const again = await proposeFromSegments(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(again.created).toEqual([]);
    expect(again.skipped.map((x) => x.reason)).toEqual([
      "already proposed this month",
      "already proposed this month",
    ]);
  });

  it("nobody emailable → nothing proposed, with the reason; posture 'no consent' switches outbound off wholesale", async () => {
    const s = await fresh();
    await addContact(s.account_id, {
      email: "someone@example.com",
      consent: { status: "implied_consent", source: "customers" },
    });
    await db
      .update(contacts)
      .set({ last_purchase_at: daysAgo(300) })
      .where(eq(contacts.account_id, s.account_id));
    const out = await proposeFromSegments(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(out.created).toEqual([]);
    expect(out.skipped.find((x) => x.segment === "lapsed")?.reason).toMatch(
      /1 in the segment, none with explicit email consent/,
    );

    await owner(s.profile_id, "customers.marketing_consent_status", "no_consent");
    const off = await proposeFromSegments(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(off.created).toEqual([]);
    expect(off.skipped).toEqual([{ segment: "all", reason: expect.stringMatching(/no consent/) }]);
  });

  it("suppression learning: three declines of customer email silence the proposal", async () => {
    const s = await fresh();
    await addContact(s.account_id, {
      email: "lapsed@example.com",
      consent: { status: "explicit_consent", source: "checkout" },
    });
    await db
      .update(contacts)
      .set({ last_purchase_at: daysAgo(300) })
      .where(eq(contacts.account_id, s.account_id));
    // Three months, each its own proposal (the month key), each declined.
    // Months AHEAD of the real clock, because a proposal expires 14 days
    // after ITS now and deciding checks expiry on real time. Computed from
    // the real clock, not pinned: pinned months expired by themselves on
    // 2026-10-15 (the first was October's 1st plus 14 days).
    const ahead = (n: number) => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
    };
    for (const at of [ahead(1), ahead(2), ahead(3)]) {
      const out = await proposeFromSegments(s.profile_id, {
        now: at,
        limitLlm: noLimits,
      });
      expect(out.created).toHaveLength(1);
      await rejectProposal({
        proposalId: out.created[0]!.id,
        userId: s.user_id,
        reason: "not now",
      });
    }
    const silenced = await proposeFromSegments(s.profile_id, {
      now: ahead(4),
      limitLlm: noLimits,
    });
    expect(silenced.created).toEqual([]);
    expect(silenced.skipped.find((x) => x.segment === "lapsed")?.reason).toMatch(
      /declined customer email 3 times/,
    );
  });
});
