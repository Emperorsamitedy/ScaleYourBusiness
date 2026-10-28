// P5-14 — deals. What must hold, each with a passing and a failing case:
//   · the stages are the bank's vocabulary, in the bank's order, and the
//     database enum is the same list;
//   · only a business that sells to businesses (6.1a b2b or both) has deals;
//   · a value is whole minor units, never negative, with a currency and a
//     basis — together or not at all, down to the database (rules 1, 2);
//   · a deal is with a Phase 4 contact: an existing one keeps its consent,
//     a new one lands `unsure` with provenance, a suppressed address is
//     refused (rules 19, 22, 23);
//   · a change records what it was and what it became; the same stage twice
//     is refused; won/lost close the deal and reopening clears it;
//   · erasing the contact erases the deal, its history and its follow-up
//     draft, and leaves the decision log untouched and free of the deal's
//     words (rules 22, 29).

import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  contacts,
  dealEvents,
  dealFollowups,
  dealStage,
  deals,
  decisionLog,
  proposals,
} from "../../db/schema";
import { addContact, eraseContact } from "../crm/contacts";
import { DealError, addDeal, listDeals, pipelineApplies, updateDeal } from "./deals";
import { DEAL_STAGES } from "./stages";
import { cleanupBusinesses, freshBusiness } from "./test-fixtures";

afterAll(cleanupBusinesses);

const EUR = (amount_minor: number) => ({ amount_minor, currency: "EUR", basis: "quoted" as const });

describe("P5-14 — the stages are the bank's vocabulary", () => {
  it("the code, the database enum and the bank list the same stages in the same order", () => {
    const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
      vocabularies: Record<string, string[]>;
    };
    expect(bank.vocabularies["deal_stage"]).toEqual([...DEAL_STAGES]);
    expect(dealStage.enumValues).toEqual([...DEAL_STAGES]);
  });
});

describe("P5-14 — who has a pipeline (rule 4)", () => {
  it("b2b and both do; b2c and an unanswered 6.1a don't, and can't add a deal", async () => {
    for (const type of ["b2b", "both"] as const) {
      expect(await pipelineApplies((await freshBusiness(type)).profile_id), type).toBe(true);
    }
    for (const type of ["b2c", null] as const) {
      const s = await freshBusiness(type);
      expect(await pipelineApplies(s.profile_id), String(type)).toBe(false);
      await expect(
        addDeal(s.account_id, s.profile_id, { contact: { name: "Someone" }, title: "A deal" }),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
});

describe("P5-14 — a deal's value is Money with provenance (rules 1, 2)", () => {
  it("stores whole minor units, the currency and the basis", async () => {
    const s = await freshBusiness();
    const row = await addDeal(s.account_id, s.profile_id, {
      contact: { name: "Café Nua", email: "orders@cafenua.example" },
      company: "Café Nua",
      title: "Spring tableware",
      value: { amount_minor: 480_000, currency: "eur", basis: "estimated" },
    });
    expect([row.value_minor, row.value_currency, row.value_basis]).toEqual([
      480_000,
      "EUR",
      "estimated",
    ]);
    expect(row.source).toBe("owner_input");
    expect(row.source_note).toBe("added on /pipeline");
    expect(row.stage).toBe("lead");
  });

  it("refuses a fraction, a negative, no currency or no basis — and the database refuses half a value", async () => {
    const s = await freshBusiness();
    const base = { contact: { name: "X Ltd" }, title: "Deal" };
    for (const value of [
      { amount_minor: 10.5, currency: "EUR", basis: "quoted" as const },
      { amount_minor: -1, currency: "EUR", basis: "quoted" as const },
      { amount_minor: 100, currency: "EURO", basis: "quoted" as const },
      { amount_minor: 100, currency: "EUR", basis: "guessed" as unknown as "quoted" },
    ]) {
      await expect(addDeal(s.account_id, s.profile_id, { ...base, value })).rejects.toBeInstanceOf(
        DealError,
      );
    }
    const ok = await addDeal(s.account_id, s.profile_id, { ...base, value: EUR(100) });
    await expect(
      db.execute(sql`update deals set value_currency = null where id = ${ok.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update deals set value_basis = 'hoped' where id = ${ok.id}`),
    ).rejects.toThrow();
  });
});

describe("P5-14 — a deal is with a contact (rules 19, 22, 23)", () => {
  it("a new contact lands unsure with its provenance; an existing one is linked with its consent untouched", async () => {
    const s = await freshBusiness();
    const fresh = await addDeal(s.account_id, s.profile_id, {
      contact: { name: "Aoife Byrne", email: "Aoife@Studio.example" },
      title: "Office mugs",
    });
    const [made] = await db.select().from(contacts).where(eq(contacts.id, fresh.contact_id));
    expect(made?.consent_status).toBe("unsure");
    expect(made?.consent_source).toMatch(/a sales conversation is not marketing consent/);

    const known = await addContact(s.account_id, {
      email: "buyer@hotel.example",
      name: "Hotel buyer",
      consent: { status: "explicit_consent", source: "signed form 2026-03-01" },
    });
    const linked = await addDeal(s.account_id, s.profile_id, {
      contact: { email: "BUYER@hotel.example" },
      title: "Breakfast service",
    });
    expect(linked.contact_id).toBe(known.id);
    const [after] = await db.select().from(contacts).where(eq(contacts.id, known.id));
    expect(after?.consent_status).toBe("explicit_consent");
    expect(after?.consent_source).toBe("signed form 2026-03-01");
  });

  it("refuses a suppressed address, and another account's contact", async () => {
    const s = await freshBusiness();
    const gone = await addContact(s.account_id, {
      email: "erased@firm.example",
      consent: { status: "unsure", source: "test" },
    });
    await eraseContact(s.account_id, gone.id);
    await expect(
      addDeal(s.account_id, s.profile_id, {
        contact: { email: "erased@firm.example" },
        title: "Comeback",
      }),
    ).rejects.toThrow(/suppressed \(erasure\)/);

    const other = await freshBusiness();
    const theirs = await addContact(other.account_id, {
      name: "Theirs",
      consent: { status: "unsure", source: "test" },
    });
    await expect(
      addDeal(s.account_id, s.profile_id, { contact: { id: theirs.id }, title: "Poach" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("P5-14 — changes keep their past", () => {
  it("a stage change records the old stage, restarts the stage's clock and closes on won", async () => {
    const s = await freshBusiness("both");
    const d = await addDeal(
      s.account_id,
      s.profile_id,
      { contact: { name: "Gallery" }, title: "Exhibition pieces", stage: "qualified" },
      undefined,
      new Date("2026-10-01T10:00:00Z"),
    );
    const sent = await updateDeal(
      s.account_id,
      d.id,
      { stage: "proposal_sent", value: EUR(900_000) },
      new Date("2026-10-10T10:00:00Z"),
    );
    expect(sent.stage_entered_at.startsWith("2026-10-10")).toBe(true);
    expect(sent.closed_at).toBeNull();
    const won = await updateDeal(
      s.account_id,
      d.id,
      { stage: "won" },
      new Date("2026-10-20T10:00:00Z"),
    );
    expect(won.closed_at?.startsWith("2026-10-20")).toBe(true);
    const reopened = await updateDeal(s.account_id, d.id, { stage: "qualified" });
    expect(reopened.closed_at).toBeNull();

    const events = await db
      .select()
      .from(dealEvents)
      .where(eq(dealEvents.deal_id, d.id))
      .orderBy(dealEvents.at);
    expect(events.map((e) => e.kind)).toEqual(["created", "stage", "value", "stage", "stage"]);
    expect(events[1]?.before).toMatchObject({ stage: "qualified" });
    expect(events[2]).toMatchObject({ before: null, after: EUR(900_000) });
  });

  it("refuses the same stage twice, a date without a step, and a conversation in the future", async () => {
    const s = await freshBusiness();
    const d = await addDeal(s.account_id, s.profile_id, { contact: { name: "Co" }, title: "T" });
    await expect(updateDeal(s.account_id, d.id, { stage: "lead" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      updateDeal(s.account_id, d.id, { next_step: { text: null, due: "2026-11-01" } }),
    ).rejects.toThrow(/needs a next step/);
    await expect(
      updateDeal(
        s.account_id,
        d.id,
        { contacted: { on: "2026-12-01" } },
        new Date("2026-10-27T10:00:00Z"),
      ),
    ).rejects.toThrow(/hasn't happened yet/);
    await expect(updateDeal(s.account_id, d.id, {})).rejects.toThrow(/nothing to change/);
    const other = await freshBusiness();
    await expect(updateDeal(other.account_id, d.id, { stage: "won" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("P5-14 — erasure goes through the deal and leaves the log alone (rules 22, 29)", () => {
  it("erasing the contact erases their deals, history and drafted follow-up; the log holds none of it", async () => {
    const s = await freshBusiness();
    const title = `Hotel Saoirse refit ${crypto.randomUUID().slice(0, 6)}`;
    const company = `Saoirse Hotels ${crypto.randomUUID().slice(0, 6)}`;
    const d = await addDeal(s.account_id, s.profile_id, {
      contact: { name: "Saoirse Kelly", email: `saoirse-${crypto.randomUUID()}@hotel.example` },
      company,
      title,
      value: EUR(1_200_000),
      next_step: "Call Saoirse about the glaze samples",
    });
    await updateDeal(s.account_id, d.id, { stage: "qualified" });
    // A drafted follow-up hangs off a proposal for this deal.
    const [p] = await db
      .insert(proposals)
      .values({
        profile_id: s.profile_id,
        module: "pipeline",
        action: { kind: "deal_followup", summary: "Follow up", detail: { deal_id: d.id } },
        scenario: {},
        reversibility: { level: "easy", if_you_change_your_mind: "nothing is sent" },
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning();
    await db.insert(dealFollowups).values({
      account_id: s.account_id,
      profile_id: s.profile_id,
      deal_id: d.id,
      proposal_id: p!.id,
      body: "Hi {{name}}, checking in.",
      disclosure: "Written with AI assistance.",
      provenance: { brief: "none" },
    });
    const before = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, s.profile_id))
      .orderBy(decisionLog.at, decisionLog.id);

    await eraseContact(s.account_id, d.contact_id);

    expect(await db.select().from(deals).where(eq(deals.id, d.id))).toHaveLength(0);
    expect(await db.select().from(dealEvents).where(eq(dealEvents.deal_id, d.id))).toHaveLength(0);
    expect(
      await db.select().from(dealFollowups).where(eq(dealFollowups.deal_id, d.id)),
    ).toHaveLength(0);
    expect(await listDeals(s.profile_id)).toHaveLength(0);

    // The log: every earlier entry exactly as it was, plus the one erasure entry.
    const after = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, s.profile_id))
      .orderBy(decisionLog.at, decisionLog.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((e) => e.kind)).toEqual(["erasure"]);
    const leaked = await db
      .select({ id: decisionLog.id })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.profile_id, s.profile_id),
          sql`(${decisionLog.ref_id} || ${decisionLog.payload_hash}) ~* ${"saoirse|hotel"}`,
        ),
      );
    expect(leaked).toHaveLength(0);
  });

  it("erasing someone else leaves this contact's deal standing", async () => {
    const s = await freshBusiness();
    const keep = await addDeal(s.account_id, s.profile_id, {
      contact: { name: "Keeper" },
      title: "Stays",
    });
    const other = await addContact(s.account_id, {
      name: "Leaver",
      consent: { status: "unsure", source: "test" },
    });
    await eraseContact(s.account_id, other.id);
    expect(await db.select().from(deals).where(eq(deals.id, keep.id))).toHaveLength(1);
  });
});
