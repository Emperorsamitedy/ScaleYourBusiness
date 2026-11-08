// P6-05 against the database: a payment is a proposal first (rule 12), a
// bad IBAN writes nothing, only approved payments are ever read for a file,
// "paid in my bank" is the owner's statement, the paying side is a stated
// fact superseded never overwritten, and erasure (rule 22) leaves the
// record of the payment and none of the payee's bank details.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  costItems,
  decisionLog,
  fieldRecords,
  intakeEvents,
  payerAccounts,
  preparedPayments,
  proposals,
  suppliers,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { approveProposal, rejectProposal } from "../proposals/service";
import { renderPain001 } from "./sepa";
import type { PaymentDraftInput } from "./store";
import {
  PaymentDraftError,
  currentPayer,
  draftPaymentProposal,
  eraseBankDetails,
  listPayments,
  markPaidInBank,
  payableThings,
  readyPayments,
  statePayer,
} from "./store";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-11-08T10:00:00Z");
const IBAN = "NL91ABNA0417164300";

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p6-05-${crypto.randomUUID()}@test.local`,
      display_name: "P6-05 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

async function fact(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(NOW.toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

const input = (over: Partial<PaymentDraftInput> = {}): PaymentDraftInput => ({
  payee_name: "Bakery Supplies BV",
  iban: IBAN,
  bic: "ABNANL2A",
  amount: { amount_minor: 61_00, currency: "EUR" },
  reference: "Flour, October",
  execution_date: "2026-11-12",
  pays: { kind: "other" },
  ...over,
});

const draft = (
  s: { account_id: string; profile_id: string },
  over: Partial<PaymentDraftInput> = {},
) =>
  draftPaymentProposal({
    profileId: s.profile_id,
    accountId: s.account_id,
    input: input(over),
    now: NOW,
  });

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(preparedPayments).where(inArray(preparedPayments.profile_id, ids));
    await db.delete(payerAccounts).where(inArray(payerAccounts.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(costItems).where(inArray(costItems.profile_id, ids));
    await db.delete(suppliers).where(inArray(suppliers.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("draftPaymentProposal — a payment is a proposal first (rule 12)", () => {
  it("records a pending proposal and its payment in one go; the proposal holds the IBAN masked only", async () => {
    const s = await fresh();
    const out = await draft(s);
    expect(out.status).toBe("pending");
    const [p] = await db.select().from(proposals).where(eq(proposals.id, out.proposal_id));
    expect(p).toMatchObject({ module: "payments", status: "pending", requires_approval: true });
    const action = p!.action as { kind: string; summary: string; detail: Record<string, unknown> };
    expect(action.kind).toBe("prepared_payment");
    expect(action.detail.iban_masked).toBe("NL•• •••• 4300");
    expect(JSON.stringify(p)).not.toContain(IBAN);
    expect(action.detail.amount).toEqual({ amount_minor: 6100, currency: "EUR" });
    expect(String(action.detail.sending)).toMatch(/Nothing is paid/);
    const [row] = await db
      .select()
      .from(preparedPayments)
      .where(eq(preparedPayments.id, out.payment_id));
    expect(row).toMatchObject({ payee_iban: IBAN, amount_minor: 6100, currency: "EUR" });
    const [logged] = await db
      .select({ kind: decisionLog.kind })
      .from(decisionLog)
      .where(eq(decisionLog.ref_id, out.proposal_id));
    expect(logged?.kind).toBe("proposal");
  });

  it("a bad IBAN is refused and writes nothing", async () => {
    const s = await fresh();
    for (const [iban, code] of [
      ["NL91ABNA0417164301", "iban_checksum"],
      ["NL91ABNA041716430", "iban_length"],
      ["ZZ91ABNA0417164300", "iban_country"],
      ["", "iban_empty"],
    ] as const) {
      await expect(draft(s, { iban })).rejects.toMatchObject({ code });
    }
    expect(await listPayments(s.profile_id)).toEqual([]);
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id))).toEqual(
      [],
    );
  });

  it("refuses float money, zero, a bad currency, a past day and a missing reference", async () => {
    const s = await fresh();
    const bad: [Partial<PaymentDraftInput>, string][] = [
      [{ amount: { amount_minor: 61.5, currency: "EUR" } }, "amount"],
      [{ amount: { amount_minor: 0, currency: "EUR" } }, "amount"],
      [{ amount: { amount_minor: 100, currency: "EURO" } }, "currency"],
      [{ execution_date: "2026-11-07" }, "date_past"],
      [{ execution_date: "2028-01-01" }, "date_far"],
      [{ reference: "  " }, "reference"],
      [{ bic: "NOPE" }, "bic"],
      [{ payee_name: "", pays: { kind: "other" } }, "name"],
    ];
    for (const [over, code] of bad) {
      await expect(draft(s, over), code).rejects.toBeInstanceOf(PaymentDraftError);
      await expect(draft(s, over), code).rejects.toMatchObject({ code });
    }
  });

  it("links to the business's own supplier or fixed cost, never another's; a supplier lends its name", async () => {
    const s = await fresh();
    const other = await fresh();
    const [sup] = await db.insert(suppliers).values({ profile_id: s.profile_id }).returning();
    await fact(s.profile_id, `suppliers.${sup!.id}.name`, "Mill & Co");
    const [cost] = await db
      .insert(costItems)
      .values({ profile_id: s.profile_id, bucket: "fixed" })
      .returning();
    await fact(s.profile_id, `costs.${cost!.id}.label`, "Rent");
    await fact(s.profile_id, `costs.${cost!.id}.amount`, { amount_minor: 95_000, currency: "EUR" });

    const things = await payableThings(s.profile_id);
    expect(things.suppliers).toEqual([{ id: sup!.id, name: "Mill & Co" }]);
    expect(things.fixed_costs).toEqual([
      { id: cost!.id, label: "Rent", amount: { amount_minor: 95_000, currency: "EUR" } },
    ]);

    const bySupplier = await draft(s, {
      payee_name: "",
      pays: { kind: "supplier", supplier_id: sup!.id },
    });
    const [row] = await db
      .select()
      .from(preparedPayments)
      .where(eq(preparedPayments.id, bySupplier.payment_id));
    expect(row).toMatchObject({
      payee_name: "Mill & Co",
      supplier_id: sup!.id,
      pays_kind: "supplier",
    });
    await draft(s, { pays: { kind: "fixed_cost", cost_item_id: cost!.id } });
    await draft(s, { pays: { kind: "purchase_order", ref: "PO-2026-014" } });

    await expect(
      draft(other, { pays: { kind: "supplier", supplier_id: sup!.id } }),
    ).rejects.toMatchObject({ code: "supplier" });
    await expect(
      draft(other, { pays: { kind: "fixed_cost", cost_item_id: cost!.id } }),
    ).rejects.toMatchObject({ code: "cost_item" });
  });
});

describe("ready for your bank — only approved payments ever reach a file", () => {
  it("a pending, declined or paid payment is never read for a file; an approved one is", async () => {
    const s = await fresh();
    const pending = await draft(s, { reference: "pending one" });
    const declined = await draft(s, { reference: "declined one" });
    const approved = await draft(s, {
      reference: "approved one",
      amount: { amount_minor: 12_345, currency: "EUR" },
    });
    const approved2 = await draft(s, { reference: "approved two", execution_date: "2026-11-30" });
    await rejectProposal({
      proposalId: declined.proposal_id,
      userId: s.user_id,
      reason: "not now",
    });
    await approveProposal({ proposalId: approved.proposal_id, userId: s.user_id });
    await approveProposal({ proposalId: approved2.proposal_id, userId: s.user_id });

    const ready = await readyPayments(s.profile_id);
    expect(ready.map((p) => p.id).sort()).toEqual(
      [approved.payment_id, approved2.payment_id].sort(),
    );
    expect(
      ready.every((p) => p.proposal_status === "approved" && p.approved_by === s.user_id),
    ).toBe(true);
    // Asking for the pending one by id still gives nothing.
    expect(await readyPayments(s.profile_id, [pending.payment_id, declined.payment_id])).toEqual(
      [],
    );

    const file = renderPain001({
      debtor: { holder_name: "Test Bakery", iban: "DE89370400440532013000", bic: null },
      payments: ready,
      msg_id: "T1",
      created_at: NOW.toISOString(),
      today: "2026-11-08",
    });
    expect(file.ctrl_sum_minor).toBe(12_345 + 6_100);
    expect(file.xml).not.toContain("pending one");
    expect(file.xml).not.toContain("declined one");

    const stages = Object.fromEntries(
      (await listPayments(s.profile_id)).map((p) => [p.reference, p.stage]),
    );
    expect(stages).toEqual({
      "pending one": "waiting",
      "declined one": "declined",
      "approved one": "ready",
      "approved two": "ready",
    });
    // The list never carries a whole IBAN.
    expect(JSON.stringify(await listPayments(s.profile_id))).not.toContain(IBAN);
  });

  it("'paid in my bank' is the owner's statement: executed, logged as the owner's, out of the ready list, once only", async () => {
    const s = await fresh();
    const one = await draft(s);
    await expect(
      markPaidInBank({
        profileId: s.profile_id,
        accountId: s.account_id,
        paymentId: one.payment_id,
        userId: s.user_id,
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    await approveProposal({ proposalId: one.proposal_id, userId: s.user_id });
    await markPaidInBank({
      profileId: s.profile_id,
      accountId: s.account_id,
      paymentId: one.payment_id,
      userId: s.user_id,
      now: NOW,
    });
    const [p] = await db.select().from(proposals).where(eq(proposals.id, one.proposal_id));
    expect(p?.status).toBe("executed");
    expect(p?.execution_result).toMatchObject({ kind: "paid_in_own_bank", stated_by: s.user_id });
    const log = await db
      .select({ kind: decisionLog.kind, actor: decisionLog.actor, user_id: decisionLog.user_id })
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, one.proposal_id), eq(decisionLog.kind, "execution")));
    expect(log).toEqual([{ kind: "execution", actor: "owner", user_id: s.user_id }]);
    expect(await readyPayments(s.profile_id)).toEqual([]);
    expect((await listPayments(s.profile_id))[0]?.stage).toBe("paid");
    await expect(
      markPaidInBank({
        profileId: s.profile_id,
        accountId: s.account_id,
        paymentId: one.payment_id,
        userId: s.user_id,
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    // Another business's payment is "no such payment".
    const other = await fresh();
    await expect(
      markPaidInBank({
        profileId: other.profile_id,
        accountId: other.account_id,
        paymentId: one.payment_id,
        userId: other.user_id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the paying side — a stated fact, superseded never overwritten (rules 2, 3)", () => {
  it("states, supersedes, keeps the old one, and refuses a bad IBAN", async () => {
    const s = await fresh();
    expect(await currentPayer(s.profile_id)).toBeNull();
    await expect(
      statePayer({
        profileId: s.profile_id,
        accountId: s.account_id,
        holderName: "Bakery",
        iban: "DE89370400440532013001",
        userId: s.user_id,
      }),
    ).rejects.toMatchObject({ code: "iban_checksum" });
    const first = await statePayer({
      profileId: s.profile_id,
      accountId: s.account_id,
      holderName: "Bakery Ltd",
      iban: "de89 3704 0044 0532 0130 00",
      userId: s.user_id,
    });
    expect(first.iban_masked).toBe("DE•• •••• 3000");
    await statePayer({
      profileId: s.profile_id,
      accountId: s.account_id,
      holderName: "Bakery Ltd",
      iban: "BE68539007547034",
      bic: "gebabebb",
      userId: s.user_id,
    });
    expect(await currentPayer(s.profile_id)).toMatchObject({
      holder_name: "Bakery Ltd",
      iban: "BE68539007547034",
      bic: "GEBABEBB",
    });
    const rows = await db
      .select()
      .from(payerAccounts)
      .where(eq(payerAccounts.profile_id, s.profile_id));
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.id === first.id)!;
    expect(old.superseded_at).not.toBeNull();
    expect(old.superseded_by).not.toBeNull();
    expect(old.iban).toBe("DE89370400440532013000");
    expect(old.source).toEqual({ kind: "owner_input" });
    const log = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, first.id));
    expect(log[0]).toMatchObject({ kind: "profile_change", actor: "owner" });
  });
});

describe("erasure (rule 22) — the payee's bank details go, the record stays", () => {
  it("by supplier: name, IBAN and BIC are nulled everywhere; the proposal's words lose the name; the log keeps no detail", async () => {
    const s = await fresh();
    const [sup] = await db.insert(suppliers).values({ profile_id: s.profile_id }).returning();
    await fact(s.profile_id, `suppliers.${sup!.id}.name`, "Jan de Vries");
    const a = await draft(s, { payee_name: "", pays: { kind: "supplier", supplier_id: sup!.id } });
    const b = await draft(s, { payee_name: "", pays: { kind: "supplier", supplier_id: sup!.id } });
    const other = await draft(s, { payee_name: "Someone Else" });
    await approveProposal({ proposalId: a.proposal_id, userId: s.user_id });

    const n = await eraseBankDetails({
      profileId: s.profile_id,
      accountId: s.account_id,
      userId: s.user_id,
      supplierId: sup!.id,
    });
    expect(n).toBe(2);
    const rows = await db
      .select()
      .from(preparedPayments)
      .where(inArray(preparedPayments.id, [a.payment_id, b.payment_id]));
    for (const r of rows) {
      expect(r).toMatchObject({
        payee_name: null,
        payee_iban: null,
        payee_bic: null,
        amount_minor: 6100,
      });
      expect(r.erased_at).not.toBeNull();
    }
    const props = await db
      .select({ action: proposals.action })
      .from(proposals)
      .where(inArray(proposals.id, [a.proposal_id, b.proposal_id]));
    for (const p of props) expect(JSON.stringify(p.action)).not.toContain("Jan de Vries");
    const [log] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, sup!.id), eq(decisionLog.kind, "erasure")));
    expect(log).toBeDefined();
    expect(JSON.stringify(log)).not.toContain(IBAN);
    // An erased payment can't reach a file any more, even approved.
    expect(await readyPayments(s.profile_id)).toEqual([]);
    // The other payee is untouched.
    const [kept] = await db
      .select()
      .from(preparedPayments)
      .where(eq(preparedPayments.id, other.payment_id));
    expect(kept?.payee_iban).toBe(IBAN);
    // By one payment, too; and twice is nothing more.
    expect(
      await eraseBankDetails({
        profileId: s.profile_id,
        accountId: s.account_id,
        userId: s.user_id,
        paymentId: other.payment_id,
      }),
    ).toBe(1);
    expect(
      await eraseBankDetails({
        profileId: s.profile_id,
        accountId: s.account_id,
        userId: s.user_id,
        paymentId: other.payment_id,
      }),
    ).toBe(0);
  });
});
