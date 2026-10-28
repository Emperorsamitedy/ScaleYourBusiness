// P5-17 — deals from a CSV, under the same attestation as contacts (P4-03).
// What must hold, each with a passing and a failing case:
//   · no attestation, no import; a value column needs its currency; the
//     header needs a deal column and someone to have it with;
//   · new contacts land under the batch's attestation with its provenance;
//     an existing contact is linked and its consent never moves; a
//     suppressed address is refused by its reason (rules 19, 22, 23);
//   · unreadable values, stages and dates are left out and counted, never
//     guessed; values are the owner's estimate unless they say quotes;
//   · re-importing the same file adds nothing;
//   · the batch is one decision-log entry with no PII; b2c can't import.

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { contactSuppressions, contacts, deals, decisionLog } from "../../db/schema";
import { addContact, emailHash } from "../crm/contacts";
import { importDeals, parseStage } from "./import";
import { cleanupBusinesses, freshBusiness } from "./test-fixtures";

afterAll(cleanupBusinesses);

const ATTEST = {
  status: "explicit_consent" as const,
  statement: "trade-fair sign-up sheet, everyone ticked 'email me'",
};

const CSV = [
  "Company,Contact,Email,Deal,Stage,Value,Expected close,Next step,Next step due,Last contact",
  "Café Nua,Aoife Byrne,aoife@cafenua.example,Spring tableware,Proposal sent,4800,2026-12-01,,,2026-10-04",
  "Hotel Saoirse,Saoirse Kelly,saoirse@hotel.example,Breakfast service,qualified,12000.50,,Send glaze samples,2026-11-02,",
  "The Long Table,,,Table settings,,not a number,someday,,2026-11-09,2099-01-01",
  "Mystery Co,Someone,someone@mystery.example,Big order,Negotiating,100,,,,",
  ",,,No one,lead,,,,,",
  "Gone Ltd,Gone,gone@gone.example,Comeback,lead,,,,,",
].join("\n");

describe("P5-17 — the import's door", () => {
  it("refuses without an attestation, without a currency for values, and without a deal column", async () => {
    const s = await freshBusiness();
    await expect(
      importDeals(s.account_id, s.profile_id, CSV, { ...ATTEST, statement: "  " }),
    ).rejects.toThrow(/attestation/);
    await expect(importDeals(s.account_id, s.profile_id, CSV, ATTEST)).rejects.toThrow(
      /which currency/,
    );
    await expect(
      importDeals(s.account_id, s.profile_id, "Company,Email\nX,x@x.example", ATTEST),
    ).rejects.toThrow(/deal column/);
    await expect(
      importDeals(s.account_id, s.profile_id, "Deal,Stage\nX,lead", ATTEST),
    ).rejects.toThrow(/who each deal is with/);
  });

  it("a business that sells only to consumers can't import deals", async () => {
    const s = await freshBusiness("b2c");
    await expect(
      importDeals(s.account_id, s.profile_id, CSV, ATTEST, { currency: "EUR" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reads stages as people write them, and refuses what isn't one", () => {
    expect(parseStage("Proposal sent")).toBe("proposal_sent");
    expect(parseStage("closed-won")).toBe("won");
    expect(parseStage("")).toBe("lead");
    expect(parseStage("Negotiating")).toBeNull();
  });
});

describe("P5-17 — importing deals under the attestation", () => {
  it("lands every row honestly, links what exists, refuses the suppressed, and logs no PII", async () => {
    const s = await freshBusiness("both");
    const known = await addContact(s.account_id, {
      email: "saoirse@hotel.example",
      name: "Saoirse Kelly",
      consent: { status: "implied_consent", source: "receipt email, 2025" },
    });
    await db.insert(contactSuppressions).values({
      account_id: s.account_id,
      email_hash: emailHash("gone@gone.example"),
      reason: "erasure",
    });

    const result = await importDeals(s.account_id, s.profile_id, CSV, ATTEST, {
      currency: "EUR",
      now: new Date("2026-10-27T10:00:00Z"),
    });
    expect(result.imported).toBe(3);
    expect(result.contacts_created).toBe(2);
    expect(result.contacts_linked).toBe(1);
    expect(result.skipped).toEqual({ suppressed: 1, already_exists: 0, invalid: 2 });
    // "not a number", "someday", a due date with no step, a last contact in 2099, "Negotiating".
    expect(result.unreadable).toEqual({ value: 1, stage: 1, dates: 3 });
    expect(result.rows.map((r) => r.outcome)).toEqual([
      "imported",
      "imported",
      "imported",
      "invalid",
      "invalid",
      "suppressed",
    ]);

    const rows = await db.select().from(deals).where(eq(deals.profile_id, s.profile_id));
    const nua = rows.find((d) => d.title === "Spring tableware")!;
    expect([nua.stage, nua.value_minor, nua.value_currency, nua.value_basis]).toEqual([
      "proposal_sent",
      480_000,
      "EUR",
      "estimated",
    ]);
    expect(nua.last_contact_at?.slice(0, 10)).toBe("2026-10-04");
    expect(nua.source).toBe("import");
    expect(nua.source_note).toBe(`import batch ${result.batch_id}: "${ATTEST.statement}"`);
    const hotel = rows.find((d) => d.title === "Breakfast service")!;
    expect(hotel.contact_id).toBe(known.id);
    expect(hotel.value_minor).toBe(1_200_050);
    expect(hotel.next_step_due).toBe("2026-11-02");
    const table = rows.find((d) => d.title === "Table settings")!;
    expect([table.stage, table.value_minor, table.next_step_due, table.last_contact_at]).toEqual([
      "lead",
      null,
      null,
      null,
    ]);

    // New contacts carry the batch's attestation; the existing one's consent never moved.
    const [aoife] = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.account_id, s.account_id), eq(contacts.email, "aoife@cafenua.example")),
      );
    expect(aoife?.consent_status).toBe("explicit_consent");
    expect(aoife?.consent_source).toContain(result.batch_id);
    const [still] = await db.select().from(contacts).where(eq(contacts.id, known.id));
    expect([still?.consent_status, still?.consent_source]).toEqual([
      "implied_consent",
      "receipt email, 2025",
    ]);
    // A company-only deal's contact is the company.
    const [longTable] = await db.select().from(contacts).where(eq(contacts.id, table.contact_id));
    expect(longTable?.name).toBe("The Long Table");
    // The suppressed address was never re-added.
    expect(
      await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.account_id, s.account_id), eq(contacts.email, "gone@gone.example"))),
    ).toHaveLength(0);

    // One log entry for the batch: its id and a hash, nothing personal.
    const entries = await db
      .select()
      .from(decisionLog)
      .where(
        and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.ref_id, result.batch_id)),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("import");
    expect(entries[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    // Quotes, when the owner says so; and the same file again adds nothing.
    const again = await importDeals(s.account_id, s.profile_id, CSV, ATTEST, {
      currency: "EUR",
      value_basis: "quoted",
      now: new Date("2026-10-27T10:00:00Z"),
    });
    expect(again.imported).toBe(0);
    expect(again.skipped.already_exists).toBe(3);
    const fresh = await importDeals(
      s.account_id,
      s.profile_id,
      "Company,Deal,Value\nNew Co,Fit-out,900",
      ATTEST,
      { currency: "EUR", value_basis: "quoted" },
    );
    expect(fresh.imported).toBe(1);
    const [fitOut] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.profile_id, s.profile_id), eq(deals.title, "Fit-out")));
    expect(fitOut?.value_basis).toBe("quoted");
  });
});
