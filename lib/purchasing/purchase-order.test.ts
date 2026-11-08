// P6-04 — purchase orders, against the database, with the global fetch
// stubbed to fail if touched and no model anywhere. What must hold (rule 27
// amended, rules 2, 12, 15, 16):
//   · a reorder suggestion becomes a PENDING purchase_order proposal: one
//     supplier, its lines with their arithmetic and Money, the address, the
//     supplier's email — recorded as a stated fact with its provenance;
//   · nothing goes out without a recorded approval: pending refuses, a
//     declined order never sends, an "approved" row with no approval on the
//     decision log refuses, and the emergency stop holds it;
//   · approved, the engine runs it: against the fake sender while real
//     sending is off (journaled, nothing leaves, the reasons kept), or for
//     real through one POST to the email service, exactly once;
//   · an order changed after approval, or a send nobody could confirm, is
//     never sent (again).

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  executionAttempts,
  executionHalts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  offers,
  proposals,
  suppliers,
  users,
  watchActivity,
} from "../../db/schema";
import { mappingKey } from "../connectors/mapping";
import type { Observation } from "../connectors/provider";
import { upsertObservations } from "../connectors/service";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { runDueExecutions } from "../execution/due";
import { haltExecutions, resumeExecutions } from "../execution/engine";
import type { PoMailFetch } from "../execution/providers/purchase-order";
import { createPurchaseOrderExecutor } from "../execution/providers/purchase-order";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal, rejectProposal } from "../proposals/service";
import { shiftDay } from "../stock/assess";
import type { PurchaseOrder } from "./po";
import { PO_KIND } from "./po";
import { PurchaseOrderError, proposePurchaseOrder } from "./propose";
import { pdfText } from "./pdf-text.test-util";
import { listPurchaseOrders, poForDocument, sendPurchaseOrderNow } from "./send";

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

let realFetchUsed = false;
const savedGate = process.env.SESSION_D_REAL_WRITES;
beforeEach(() => {
  realFetchUsed = false;
  delete process.env.SESSION_D_REAL_WRITES;
  vi.stubGlobal("fetch", async () => {
    realFetchUsed = true;
    throw new Error("no real network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedGate === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = savedGate;
  expect(realFetchUsed).toBe(false);
});

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  const runs = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (runs.length > 0) {
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        runs.map((r) => r.id),
      ),
    );
  }
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(executionHalts).where(inArray(executionHalts.account_id, accountIds));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(suppliers).where(inArray(suppliers.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(offers).where(inArray(offers.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.8),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const MUG = "gid://shopify/Product/1";
const PLATE = "gid://shopify/Product/2";

/**
 * A stocked shop (the reorder notes' own fixture): a mug selling 3 a day with
 * 12 left, matched to an offer whose clay supplier takes 7 days with a
 * minimum order of 50; a plate with plenty. 120 days measured.
 */
async function shop(opts: { mode?: "instant" | "watching"; address?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await answer(s.profile_id, "identity.sells", [{ code: "physical_products" }]);
  await answer(s.profile_id, "identity.legal_name", "Fernhill Ceramics");
  if (opts.address ?? true) {
    await answer(s.profile_id, "legal.postal_address", "Unit 4, Mill Lane, Stroud GL5 1AA");
  }
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: opts.mode ?? "instant",
    watch_weeks: opts.mode === "watching" ? 6 : null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: s.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await answer(s.profile_id, `offers.${offer!.id}.name`, "Blue Mug");
  await answer(s.profile_id, mappingKey(offer!.id, "shopify"), { product_ref: MUG });
  const [sup] = await db
    .insert(suppliers)
    .values({ profile_id: s.profile_id })
    .returning({ id: suppliers.id });
  await answer(s.profile_id, `suppliers.${sup!.id}.name`, "Midland Clay");
  await answer(s.profile_id, `suppliers.${sup!.id}.lead_time_days`, 7);
  await answer(s.profile_id, `suppliers.${sup!.id}.moq`, 50);
  await answer(s.profile_id, `suppliers.${sup!.id}.supplies_offers`, [{ code: offer!.id }]);

  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "shopify" })
    .returning({ id: connections.id });
  const obs: Observation[] = [];
  const at = NOW.toISOString();
  for (let i = 1; i <= 120; i++) {
    const day = shiftDay(TODAY, -i);
    obs.push({
      metric_key: "orders.daily",
      period_date: day,
      dimensions: {},
      value_num: 4,
      observed_at: at,
    });
    for (const [ref, u] of [
      [MUG, 3],
      [PLATE, 1],
    ] as const) {
      obs.push({
        metric_key: "units.daily",
        period_date: day,
        dimensions: { product_ref: ref },
        value_num: u,
        observed_at: at,
      });
    }
  }
  const snap = (ref: string, name: string, q: number, cost: number) => {
    const dims = { product_ref: ref, item_name: name };
    obs.push({
      metric_key: "stock.on_hand",
      period_date: TODAY,
      dimensions: dims,
      value_num: q,
      observed_at: at,
    });
    obs.push({
      metric_key: "stock.value_at_cost",
      period_date: TODAY,
      dimensions: { ...dims, currency: "EUR" },
      value_minor: q * cost,
      observed_at: at,
    });
  };
  snap(MUG, "Blue Mug", 12, 980);
  snap(PLATE, "Dinner Plate", 200, 1_250);
  await upsertObservations(conn!.id, "shopify", obs);
  const [owner] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `po-owner-${crypto.randomUUID()}@test.local`,
      display_name: "Stock owner",
      role: "owner",
    })
    .returning({ id: users.id, email: users.email });
  return { ...s, supplier_id: sup!.id, owner_id: owner!.id, owner_email: owner!.email };
}

const detailOf = (p: typeof proposals.$inferSelect) =>
  (p.action as { detail: { po: PurchaseOrder; po_sha256: string } & Record<string, unknown> })
    .detail;

async function propose(s: Awaited<ReturnType<typeof shop>>, over: Record<string, unknown> = {}) {
  return proposePurchaseOrder({
    profileId: s.profile_id,
    supplierId: s.supplier_id,
    email: "Orders@Midland.test",
    now: NOW,
    limitLlm: noLimits,
    ...over,
  });
}

async function runsOf(proposalId: string) {
  return db.select().from(executions).where(eq(executions.proposal_id, proposalId));
}

/**
 * A real-mode provider whose network is a recorder: the email service as the
 * test says. Real mode means the real-write gate is on, so the test turns it
 * on (afterEach puts it back): the engine's guard 6a reads the same switch.
 */
function realProvider(answerWith: (n: number) => Response) {
  process.env.SESSION_D_REAL_WRITES = "on";
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch: PoMailFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return answerWith(calls.length);
  };
  const provider = createPurchaseOrderExecutor({
    fetch,
    mode: () => ({ mode: "real", api_key: "re_test", from_address: "hello@syb.test" }),
  });
  return { provider, calls };
}

const ok = () =>
  new Response(JSON.stringify({ id: "re_msg_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("P6-04 a reorder suggestion becomes a purchase order proposal", () => {
  it("is PENDING, with lines, arithmetic, Money, the address and the supplier's email", async () => {
    const s = await shop();
    const row = await propose(s);
    expect(row.status).toBe("pending");
    expect(row.module).toBe("stock");
    expect((row.action as { kind: string }).kind).toBe(PO_KIND);
    const d = detailOf(row);
    expect(d.po).toMatchObject({
      number: "PO-0001",
      business: "Fernhill Ceramics",
      supplier: { id: s.supplier_id, name: "Midland Clay", email: "orders@midland.test" },
      delivery_address: "Unit 4, Mill Lane, Stroud GL5 1AA",
      delivery_address_field: "legal.postal_address",
      unpriced: 0,
    });
    // Only the mug runs low; its quantity rounds up to Midland Clay's minimum of 50.
    expect(d.po.lines).toHaveLength(1);
    expect(d.po.lines[0]).toMatchObject({
      name: "Blue Mug",
      quantity: 50,
      suggested: 50,
      unit_cost: { amount_minor: 980, currency: "EUR" },
      line_total: { amount_minor: 49_000, currency: "EUR" },
    });
    expect(d.po.lines[0]!.arithmetic).toMatch(/Midland Clay's minimum order is 50, so 50\.$/);
    expect(d.po.totals).toEqual([{ amount_minor: 49_000, currency: "EUR" }]);
    expect(d.execute_on_approval).toBe(true);
    expect(d.sending).toContain("Approving emails this order to orders@midland.test");
    expect(row.reversibility).toMatchObject({ level: "hard" });
    expect((row.action as { summary: string }).summary).toBe(
      "Email purchase order PO-0001 to Midland Clay: 50 × Blue Mug, about €490.00 at cost",
    );
    // Its decision-log entry was written with it (rule 12).
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, row.id), eq(decisionLog.kind, "proposal")));
    expect(log).toHaveLength(1);
  });

  it("records the supplier's email as a stated fact with provenance (rule 2), superseded when it changes", async () => {
    const s = await shop();
    await propose(s);
    const key = `suppliers.${s.supplier_id}.email`;
    const f = await readCurrentField<string>(s.profile_id, key);
    expect(f).toMatchObject({
      value: "orders@midland.test",
      status: "answered",
      source: { kind: "owner_input" },
    });
    // A second order with a new address supersedes the first, never overwrites it.
    const [first] = await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    await rejectProposal({ proposalId: first!.id, userId: s.owner_id, reason: "wrong address" });
    const again = await propose(s, { email: "sales@midland.test" });
    expect(detailOf(again).po.number).toBe("PO-0002");
    const history = await readFieldHistory<string>(s.profile_id, key);
    expect(history.map((h) => h.field.value)).toEqual([
      "orders@midland.test",
      "sales@midland.test",
    ]);
  });

  it("an owner's own quantity is kept beside the suggestion, and a bad one is refused", async () => {
    const s = await shop();
    const key = (await poForKey(s)).key;
    await expect(propose(s, { quantities: { [key]: "2.5" } })).rejects.toThrow(
      /whole number from 1/,
    );
    const row = await propose(s, { quantities: { [key]: "60" } });
    const line = detailOf(row).po.lines[0]!;
    expect(line).toMatchObject({ quantity: 60, suggested: 50 });
    expect(line.arithmetic).toMatch(/^You chose 60; the suggestion was 50: /);
  });

  it("asks for what it needs: an email that is one address, and a delivery address", async () => {
    const s = await shop({ address: false });
    await expect(propose(s, { email: "not an address" })).rejects.toBeInstanceOf(
      PurchaseOrderError,
    );
    await expect(propose(s)).rejects.toThrow(/Say where the order should be delivered/);
    const row = await propose(s, { deliveryAddress: "  The Barn\r\nHigh St  " });
    expect(detailOf(row).po).toMatchObject({
      delivery_address: "The Barn\nHigh St",
      delivery_address_field: null,
    });
    // One open order per supplier at a time.
    await expect(propose(s, { deliveryAddress: "The Barn" })).rejects.toThrow(
      /already an order for Midland Clay \(PO-0001\) waiting/,
    );
    // Nothing was recorded from the refused attempts but the one good address.
    const f = await readCurrentField<string>(s.profile_id, `suppliers.${s.supplier_id}.email`);
    expect(f?.value).toBe("orders@midland.test");
  });

  it("a watched business gets no order (rule 15)", async () => {
    const s = await shop({ mode: "watching" });
    await expect(propose(s)).rejects.toThrow(
      /No purchase order can be made yet: I'm watching until/,
    );
    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    expect(rows).toHaveLength(0);
  });
});

async function poForKey(s: { profile_id: string; supplier_id: string }) {
  const { loadCover } = await import("../stock/cover-load");
  const [p] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, s.profile_id));
  const view = await loadCover(p!.account_id, s.profile_id, NOW);
  const row = view.warnings.find((r) => r.cover.lead.supplier?.id === s.supplier_id)!;
  return { key: `${row.item.connection_id}:${row.item.ref}` };
}

describe("P6-04 nothing goes out without a recorded approval (rule 12)", () => {
  it("a pending order refuses, with no execution row and nothing sent", async () => {
    const s = await shop();
    const row = await propose(s);
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out).toMatchObject({ result: "refused" });
    expect(out.message).toMatch(/only an approved proposal can execute — this one is pending/);
    expect(calls).toHaveLength(0);
    expect(await runsOf(row.id)).toHaveLength(0);
  });

  it("another business's order, or an id that isn't one, is no such order (404), never a 500", async () => {
    const a = await shop();
    const b = await shop();
    const row = await propose(a);
    const { provider, calls } = realProvider(ok);
    for (const [profileId, proposalId] of [
      [b.profile_id, row.id],
      [a.profile_id, "PO-0001"],
      [a.profile_id, "1; drop table proposals"],
    ] as const) {
      await expect(
        sendPurchaseOrderNow({ profileId, proposalId, provider }),
        proposalId,
      ).rejects.toMatchObject({ name: "PurchaseOrderSendError", status: 404 });
    }
    expect(calls).toHaveLength(0);
  });

  it("a declined order never sends — not by a click, not by the due runner", async () => {
    const s = await shop();
    const row = await propose(s);
    await rejectProposal({ proposalId: row.id, userId: s.owner_id, reason: "not this month" });
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out.result).toBe("refused");
    const due = await runDueExecutions({
      profileId: s.profile_id,
      sleep: async () => {},
      providers: { purchase_order: provider },
    });
    expect(due.due).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await runsOf(row.id)).toHaveLength(0);
  });

  it("an 'approved' row with no approval on the decision log refuses before anything runs", async () => {
    const s = await shop();
    const row = await propose(s);
    // Flipped behind the queue's back: no approval entry was ever written.
    await db
      .update(proposals)
      .set({ status: "approved", decided_by: s.owner_id, decided_at: NOW.toISOString() })
      .where(eq(proposals.id, row.id));
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out.result).toBe("refused");
    expect(out.message).toMatch(/no recorded approval for this order/);
    expect(calls).toHaveLength(0);
    expect(await runsOf(row.id)).toHaveLength(0);
  });

  it("the emergency stop blocks it, and it goes after the resume", async () => {
    const s = await shop();
    const row = await propose(s);
    await approveProposal({ proposalId: row.id, userId: s.owner_id });
    await haltExecutions({ accountId: s.account_id, userId: s.owner_id });
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out.result).toBe("refused");
    expect(out.message).toMatch(/emergency stop is on/);
    expect(calls).toHaveLength(0);
    await resumeExecutions(s.account_id, s.owner_id);
    const sent = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(sent.result).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("an order changed after its approval doesn't go out", async () => {
    const s = await shop();
    const row = await propose(s);
    await approveProposal({ proposalId: row.id, userId: s.owner_id });
    const d = detailOf(row);
    const tampered = {
      ...d,
      po: { ...d.po, supplier: { ...d.po.supplier, email: "x@evil.test" } },
    };
    await db
      .update(proposals)
      .set({ action: { ...(row.action as object), detail: tampered } })
      .where(eq(proposals.id, row.id));
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out.result).toBe("refused");
    expect(out.message).toMatch(/changed since it was approved/);
    expect(calls).toHaveLength(0);
  });
});

describe("P6-04 approved, the engine runs it", () => {
  it("while real sending is off: the due runner runs it against the fake sender — journaled, nothing sent, the reasons kept", async () => {
    const s = await shop();
    const row = await propose(s);
    const approved = await approveProposal({ proposalId: row.id, userId: s.owner_id });
    // execute_on_approval: approving schedules it for now.
    expect(approved.execute_not_before).not.toBeNull();
    const due = await runDueExecutions({ profileId: s.profile_id, sleep: async () => {} });
    expect(due.executed).toBe(1);
    const [run] = await runsOf(row.id);
    expect(run).toMatchObject({
      provider: "purchase_order",
      op: "send_purchase_order",
      status: "succeeded",
    });
    expect(run!.result).toMatchObject({
      sent: false,
      number: "PO-0001",
      to_domain: "midland.test",
    });
    expect((run!.result as { not_sent: string[] }).not_sent).toContain("real_writes_off");
    // P6-09: the fake sender records the one PDF the email would have carried.
    const attachments = (run!.result as { attachments: { filename: string; bytes: number }[] })
      .attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("PO-0001.pdf");
    expect(attachments[0]!.bytes).toBeGreaterThan(1_000);
    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id));
    expect(after!.status).toBe("executed");
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, row.id), eq(decisionLog.kind, "execution")));
    expect(log).toHaveLength(1);
    // The screen reads "ready, not sent", with why.
    const [view] = await listPurchaseOrders(s.profile_id);
    expect(view).toMatchObject({ number: "PO-0001", status: "executed", sent: false });
    expect(view!.not_sent).toContain("real_writes_off");
    expect((await poForDocument(s.profile_id, row.id))?.status).toEqual({ kind: "not_sent" });
    // Another business never gets this order as a document (the PDF route's gate).
    const other = await bootstrapIntake();
    expect(await poForDocument(other.profile_id, row.id)).toBeNull();
  });

  it("for real: one POST to the email service, to the supplier as approved, replies to the approver — exactly once", async () => {
    const s = await shop();
    const row = await propose(s);
    await approveProposal({ proposalId: row.id, userId: s.owner_id });
    const { provider, calls } = realProvider(ok);
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out).toEqual({ result: "sent" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      `syb-po-${row.id}`,
    );
    expect(call.body).toMatchObject({
      from: '"Fernhill Ceramics via SYB" <hello@syb.test>',
      to: ["orders@midland.test"],
      reply_to: s.owner_email,
      subject: "Purchase order PO-0001 from Fernhill Ceramics",
    });
    expect(String(call.body.text)).toContain("50 × Blue Mug at €9.80 = €490.00");
    // P6-09: exactly one attachment, the order as a PDF that parses and carries it.
    const attachments = call.body.attachments as { filename: string; content: string }[];
    expect(attachments).toHaveLength(1);
    expect(Object.keys(attachments[0]!).sort()).toEqual(["content", "filename"]);
    expect(attachments[0]!.filename).toBe("PO-0001.pdf");
    const pdf = Uint8Array.from(Buffer.from(attachments[0]!.content, "base64"));
    const read = (await pdfText(pdf)).runs.join("\n");
    expect(read).toContain("Purchase order PO-0001");
    expect(read).toContain("Blue Mug");
    expect(read).toContain("€490.00");
    expect(read).toContain(`Emailed to the supplier on`);
    // Again: the engine's idempotency hands back the same run, and nothing is sent twice.
    const again = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(again.result).toBe("sent");
    expect(calls).toHaveLength(1);
    const [view] = await listPurchaseOrders(s.profile_id);
    expect(view).toMatchObject({ sent: true, sent_on: TODAY });
  });

  it("a send nobody could confirm is never repeated", async () => {
    const s = await shop();
    const row = await propose(s);
    await approveProposal({ proposalId: row.id, userId: s.owner_id });
    const { provider, calls } = realProvider(() => new Response("oops", { status: 502 }));
    const out = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(out.result).toBe("failed");
    expect(out.message).toMatch(/didn't confirm whether this order went out/);
    expect(calls).toHaveLength(1);
    const again = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(again.result).toBe("refused");
    expect(calls).toHaveLength(1);
  });

  it("a refusal by the email service sent nothing, and the order can go again", async () => {
    const s = await shop();
    const row = await propose(s);
    await approveProposal({ proposalId: row.id, userId: s.owner_id });
    const { provider, calls } = realProvider((n) =>
      n === 1 ? new Response("{}", { status: 422 }) : ok(),
    );
    const first = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(first.result).toBe("failed");
    expect(first.message).toMatch(/refused the order \(it answered 422\)\. Nothing went out/);
    const second = await sendPurchaseOrderNow({
      profileId: s.profile_id,
      proposalId: row.id,
      provider,
    });
    expect(second.result).toBe("sent");
    expect(calls).toHaveLength(2);
  });
});
