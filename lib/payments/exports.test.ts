// P6-05, the owner's decisions of 2026-11-09, against the database: a
// payment is never in two new files (whichever format, whatever the
// timing), "download again" gives the same bytes with the same MsgId — even
// after the "pay from" details changed or a payment was marked paid — a copy
// of the steps says it is a copy, and a file whose payment was erased can't
// be made again.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  payerAccounts,
  paymentExportItems,
  paymentExports,
  preparedPayments,
  proposals,
  users,
} from "../../db/schema";
import { englishTr } from "../i18n/tr";
import { bootstrapIntake } from "../intake/service";
import { approveProposal } from "../proposals/service";
import { exportAgain, exportNewFile, listExports } from "./exports";
import type { StepsWords } from "./instructions";
import type { PaymentDraftInput } from "./store";
import {
  draftPaymentProposal,
  eraseBankDetails,
  listPayments,
  markPaidInBank,
  statePayer,
} from "./store";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-11-09T10:00:00.456Z");
const LATER = new Date("2026-11-10T09:30:00Z");
const WORDS: StepsWords = { tr: englishTr("payments.steps"), locale: "en" };
const wordsFor = async () => WORDS;

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p6-05-export-${crypto.randomUUID()}@test.local`,
      display_name: "Export owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await statePayer({
    profileId: s.profile_id,
    accountId: s.account_id,
    holderName: "Bakery Ltd",
    iban: "DE89370400440532013000",
    userId: u!.id,
    now: NOW,
  });
  return { ...s, user_id: u!.id };
}

type S = Awaited<ReturnType<typeof fresh>>;

const input = (over: Partial<PaymentDraftInput> = {}): PaymentDraftInput => ({
  payee_name: "Bakery Supplies BV",
  iban: "NL91ABNA0417164300",
  bic: "ABNANL2A",
  amount: { amount_minor: 61_00, currency: "EUR" },
  reference: "Flour, October",
  execution_date: "2026-11-12",
  pays: { kind: "other" },
  ...over,
});

/** A payment drafted and approved: ready for the bank. */
async function ready(s: S, over: Partial<PaymentDraftInput> = {}): Promise<string> {
  const d = await draftPaymentProposal({
    profileId: s.profile_id,
    accountId: s.account_id,
    input: input(over),
    now: NOW,
  });
  await approveProposal({ proposalId: d.proposal_id, userId: s.user_id });
  return d.payment_id;
}

const newFile = (s: S, format: "sepa" | "steps", now = NOW, ids?: string[]) =>
  exportNewFile({
    profileId: s.profile_id,
    accountId: s.account_id,
    format,
    userId: s.user_id,
    words: WORDS,
    now,
    ...(ids ? { ids } : {}),
  });

const again = (s: S, exportId: string) =>
  exportAgain({ profileId: s.profile_id, accountId: s.account_id, exportId, wordsFor });

const itemsOf = async (paymentIds: string[]) =>
  db
    .select({ export_id: paymentExportItems.export_id, payment_id: paymentExportItems.payment_id })
    .from(paymentExportItems)
    .where(inArray(paymentExportItems.payment_id, paymentIds));

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(paymentExports).where(inArray(paymentExports.profile_id, ids));
    await db.delete(preparedPayments).where(inArray(preparedPayments.profile_id, ids));
    await db.delete(payerAccounts).where(inArray(payerAccounts.profile_id, ids));
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

describe("a payment is never in two new files", () => {
  it("a second new file of either format refuses what the first took, and takes only what is new", async () => {
    const s = await fresh();
    const a = await ready(s);
    const b = await ready(s, { reference: "Butter" });
    const first = await newFile(s, "sepa");
    expect(first.count).toBe(2);
    expect(first.body).toContain(`<MsgId>${first.msg_id}</MsgId>`);
    expect(first.body).toContain("<NbOfTxs>2</NbOfTxs>");

    await expect(newFile(s, "sepa")).rejects.toMatchObject({ code: "all_in_file" });
    await expect(newFile(s, "steps")).rejects.toMatchObject({ code: "all_in_file" });
    // Naming the payments outright doesn't put them in a second file either.
    await expect(newFile(s, "sepa", NOW, [a, b])).rejects.toMatchObject({ code: "all_in_file" });

    const c = await ready(s, { reference: "Yeast" });
    const second = await newFile(s, "sepa", LATER);
    expect(second.count).toBe(1);
    expect(second.msg_id).not.toBe(first.msg_id);
    expect(second.body).toContain("Yeast");
    expect(second.body).not.toContain("Butter");

    const items = await itemsOf([a, b, c]);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.payment_id)).size).toBe(3);
  });

  it("the steps take every ready payment in no file, any currency; the SEPA file then has none left", async () => {
    const s = await fresh();
    await ready(s);
    await ready(s, { amount: { amount_minor: 120_000, currency: "HUF" }, reference: "Forint" });
    const steps = await newFile(s, "steps");
    expect(steps.count).toBe(2);
    expect(steps.body.split("\n")[0]).toBe(
      `File ${steps.msg_id}, made on 2026-11-09. No payment in it is in any other file ScaleX made.`,
    );
    expect(steps.filename).toBe(`syb-payments-2026-11-09-${steps.msg_id}.txt`);
    await expect(newFile(s, "sepa")).rejects.toMatchObject({ code: "all_in_file" });
  });

  it("two downloads at the same moment: one file gets the payments, the other is refused", async () => {
    const s = await fresh();
    const ids = [await ready(s), await ready(s, { reference: "Salt" })];
    const results = await Promise.allSettled([newFile(s, "sepa"), newFile(s, "steps")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: expect.stringMatching(/^(taken|all_in_file)$/),
    });
    const items = await itemsOf(ids);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.export_id)).size).toBe(1);
  });

  it("the database itself refuses a payment in a second file", async () => {
    const s = await fresh();
    const a = await ready(s);
    const first = await newFile(s, "sepa");
    const [other] = await db
      .insert(paymentExports)
      .values({
        profile_id: s.profile_id,
        format: "steps",
        msg_id: `SYBTEST${crypto.randomUUID().slice(0, 8)}`,
        created_at: NOW.toISOString(),
        made_on: "2026-11-09",
        locale: "en",
        nb_of_txs: 1,
        sha256: "x",
      })
      .returning({ id: paymentExports.id });
    await expect(
      db.insert(paymentExportItems).values({ export_id: other!.id, payment_id: a, position: 0 }),
    ).rejects.toThrow();
    expect((await itemsOf([a]))[0]?.export_id).toBe(first.export_id);
  });

  it("refuses when nothing is ready, and SEPA without euros between SEPA banks", async () => {
    const s = await fresh();
    await expect(newFile(s, "sepa")).rejects.toMatchObject({ code: "none_ready" });
    await ready(s, { amount: { amount_minor: 50_00, currency: "USD" } });
    await expect(newFile(s, "sepa")).rejects.toMatchObject({ code: "none_for_file" });
  });
});

describe("download again: the same file, the same MsgId", () => {
  it("is byte for byte the first download, even after the pay-from details change and a payment is marked paid", async () => {
    const s = await fresh();
    const a = await ready(s);
    await ready(s, { reference: "Sugar", execution_date: "2026-11-09" });
    const first = await newFile(s, "sepa");

    await statePayer({
      profileId: s.profile_id,
      accountId: s.account_id,
      holderName: "Bakery Holdings",
      iban: "NL91ABNA0417164300",
      userId: s.user_id,
      now: LATER,
    });
    await markPaidInBank({
      profileId: s.profile_id,
      accountId: s.account_id,
      paymentId: a,
      userId: s.user_id,
      now: LATER,
    });

    const copy = await again(s, first.export_id);
    expect(copy.again).toBe(true);
    expect(copy.same_bytes).toBe(true);
    expect(copy.msg_id).toBe(first.msg_id);
    expect(copy.body).toBe(first.body);
    expect(copy.filename).toBe(first.filename);
    expect(copy.filename).toBe(`syb-sepa-2026-11-09-${first.msg_id}.xml`);
    expect(copy.body).toContain("<CreDtTm>2026-11-09T10:00:00</CreDtTm>");
    expect(copy.body).toContain("Bakery Ltd");
    expect(copy.body).not.toContain("Bakery Holdings");
    // Twice more: still the same.
    expect((await again(s, first.export_id)).body).toBe(first.body);
  });

  it("a copy of the steps says first that it is a copy, then is the same text", async () => {
    const s = await fresh();
    await ready(s, { amount: { amount_minor: 9_900, currency: "GBP" } });
    const first = await newFile(s, "steps");
    const copy = await again(s, first.export_id);
    const [line, blank, ...rest] = copy.body.split("\n");
    expect(line).toMatch(/^COPY of a file first downloaded on 2026-11-09\./);
    expect(blank).toBe("");
    expect(rest.join("\n")).toBe(first.body);
    expect(copy.same_bytes).toBe(true);
  });

  it("refuses a file whose payment was erased, and another business's file", async () => {
    const s = await fresh();
    const a = await ready(s);
    const first = await newFile(s, "sepa");
    const other = await fresh();
    await expect(again(other, first.export_id)).rejects.toMatchObject({ code: "no_such_file" });
    await eraseBankDetails({
      profileId: s.profile_id,
      accountId: s.account_id,
      userId: s.user_id,
      paymentId: a,
    });
    await expect(again(s, first.export_id)).rejects.toMatchObject({ code: "file_erased" });
  });
});

describe("what the screen reads", () => {
  it("each payment names its file; the files list says who, how many and how many paid", async () => {
    const s = await fresh();
    const a = await ready(s);
    const b = await ready(s, { reference: "Eggs" });
    const first = await newFile(s, "sepa", NOW, [a]);
    await markPaidInBank({
      profileId: s.profile_id,
      accountId: s.account_id,
      paymentId: a,
      userId: s.user_id,
      now: LATER,
    });
    const list = await listPayments(s.profile_id);
    expect(list.find((p) => p.id === a)?.in_file).toEqual({
      export_id: first.export_id,
      format: "sepa",
      msg_id: first.msg_id,
      made_on: "2026-11-09",
    });
    expect(list.find((p) => p.id === b)?.in_file).toBeNull();
    expect(list).toHaveLength(2);
    expect(await listExports(s.profile_id)).toEqual([
      {
        id: first.export_id,
        format: "sepa",
        msg_id: first.msg_id,
        created_at: "2026-11-09T10:00:00.000Z",
        made_on: "2026-11-09",
        by: "Export owner",
        count: 1,
        paid: 1,
        again: true,
      },
    ]);
  });
});
