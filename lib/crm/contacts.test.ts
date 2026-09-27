// Phase 4 Session A — P4-01/02/04. What must hold: consent gradations
// are law at the gate (explicit yes; implied, unsure and none refused
// for marketing, each by name); transactional replies ignore consent
// but never suppression; the 6.4b answer sets module posture; and one
// full erasure leaves the row gone, the suppression standing, re-entry
// refused, and a decision-log trail that verifies while holding no PII
// — the rule 7 / GDPR reconciliation, proven rather than promised.

import "dotenv/config";
import { and, eq, inArray, like, or } from "drizzle-orm";
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
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import {
  ContactError,
  addContact,
  canEmailForMarketing,
  canEmailTransactional,
  emailHash,
  eraseContact,
  outboundPosture,
} from "./contacts";
import { importContacts } from "./import";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const consented = { status: "explicit_consent" as const, source: "test attestation" };

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  for (const s of created) {
    await db.delete(contacts).where(eq(contacts.account_id, s.account_id));
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, s.account_id));
  }
  if (ids.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P4-01 — the contact spine", () => {
  it("records consent with provenance; refuses a contact with neither identity nor source", async () => {
    const s = await fresh();
    const row = await addContact(s.account_id, {
      email: "  Anna@Example.COM ",
      name: "Anna",
      consent: consented,
    });
    expect(row.email).toBe("anna@example.com"); // normalized at the door
    expect(row.consent_status).toBe("explicit_consent");
    expect(row.consent_source).toBe("test attestation");
    expect(row.consent_captured_at).not.toBeNull();

    await expect(addContact(s.account_id, { consent: consented })).rejects.toThrow(
      /at least an email/,
    );
    await expect(
      addContact(s.account_id, {
        email: "b@example.com",
        consent: { status: "unsure", source: "  " },
      }),
    ).rejects.toThrow(/provenance/);
  });

  it("unique per (account, email); the same address on ANOTHER account is fine; partial contacts are real", async () => {
    const a = await fresh();
    const b = await fresh();
    await addContact(a.account_id, { email: "dup@example.com", consent: consented });
    await expect(
      addContact(a.account_id, { email: "DUP@example.com", consent: consented }),
    ).rejects.toThrow(/already exists/);
    // Accounts are worlds apart:
    const other = await addContact(b.account_id, { email: "dup@example.com", consent: consented });
    expect(other.email).toBe("dup@example.com");
    // And two email-less partial contacts coexist (partial unique index):
    await addContact(a.account_id, { name: "Walk-in one", consent: consented });
    await addContact(a.account_id, { name: "Walk-in two", consent: consented });
  });
});

describe("P4-02 — the consent gate, every gradation at its boundary", () => {
  it("marketing: explicit yes; implied, unsure and none refused BY NAME", async () => {
    const s = await fresh();
    const cases: [
      string,
      "explicit_consent" | "implied_consent" | "no_consent" | "unsure",
      boolean,
    ][] = [
      ["explicit@example.com", "explicit_consent", true],
      ["implied@example.com", "implied_consent", false],
      ["unsure@example.com", "unsure", false],
      ["none@example.com", "no_consent", false],
    ];
    for (const [email, status, allowed] of cases) {
      const contact = await addContact(s.account_id, {
        email,
        consent: { status, source: "test" },
      });
      const verdict = await canEmailForMarketing(contact);
      expect(verdict.allowed, email).toBe(allowed);
      if (!allowed && status !== "explicit_consent") {
        expect(verdict.reason).toContain(status.replace(/_/g, " "));
      }
    }
  });

  it("transactional replies ignore consent gradation but never suppression", async () => {
    const s = await fresh();
    const contact = await addContact(s.account_id, {
      email: "ticket@example.com",
      consent: { status: "no_consent", source: "inbound support email" },
    });
    expect((await canEmailTransactional(contact)).allowed).toBe(true);
    expect((await canEmailForMarketing(contact)).allowed).toBe(false);

    await db.insert(contactSuppressions).values({
      account_id: s.account_id,
      email_hash: emailHash("ticket@example.com"),
      reason: "unsubscribed",
    });
    const afterSuppression = await canEmailTransactional(contact);
    expect(afterSuppression.allowed).toBe(false);
    expect(afterSuppression.reason).toContain("unsubscribed");
  });

  it("the 6.4b answer sets module posture; unanswered is unknown, never permission", async () => {
    const s = await fresh();
    expect(await outboundPosture(s.profile_id)).toBe("unknown");
    const at = isoDateTime(new Date().toISOString());
    for (const [code, posture] of [
      ["no_consent", "disabled"],
      ["unsure", "caution"],
      ["implied_consent", "caution"],
      ["explicit_consent", "enabled"],
    ] as const) {
      await writeField(
        s.profile_id,
        createField<string>({
          id: fieldId("customers.marketing_consent_status"),
          value: code,
          status: "answered",
          confidence: confidence(0.75),
          source: { kind: "owner_input" },
          observed_at: at,
          recorded_at: at,
        }),
      );
      expect(await outboundPosture(s.profile_id), code).toBe(posture);
    }
  });
});

describe("P4-04 — erasure: the row goes, the trail stays clean (rule 22)", () => {
  it("erases, suppresses forever, refuses re-entry, and the log holds no PII", async () => {
    const s = await fresh();
    const email = "erase-me-p4@example.com";
    const contact = await addContact(s.account_id, {
      email,
      name: "Erase Me",
      phone: "+36 30 555 0000",
      consent: consented,
    });

    await eraseContact(s.account_id, contact.id);

    // The row is gone.
    const remaining = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(remaining).toHaveLength(0);

    // The suppression stands, as a hash with its reason.
    const [suppression] = await db
      .select()
      .from(contactSuppressions)
      .where(
        and(
          eq(contactSuppressions.account_id, s.account_id),
          eq(contactSuppressions.email_hash, emailHash(email)),
        ),
      );
    expect(suppression?.reason).toBe("erasure");

    // Re-entry is refused by the reason, forever.
    await expect(addContact(s.account_id, { email, consent: consented })).rejects.toThrow(
      /suppressed \(erasure\)/,
    );

    // The decision log recorded the FACT of the erasure…
    const entries = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.kind, "erasure")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ref_id).toBe(contact.id);

    // …and NOTHING in the log for this profile contains the PII.
    const leaked = await db
      .select({ id: decisionLog.id })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.profile_id, s.profile_id),
          or(like(decisionLog.ref_id, `%${email}%`), like(decisionLog.payload_hash, `%${email}%`)),
        ),
      );
    expect(leaked).toHaveLength(0);

    // Erasing a contact that never existed is a 404, not a crash.
    await expect(eraseContact(s.account_id, crypto.randomUUID())).rejects.toThrow(ContactError);
  });
});

describe("P4-03 — import under attestation", () => {
  it("imports with the attestation as every row's provenance; every line gets an outcome", async () => {
    const s = await fresh();
    // Seed a suppression (an earlier erasure) and an existing contact.
    await addContact(s.account_id, { email: "existing@example.com", consent: consented });
    const erased = await addContact(s.account_id, {
      email: "gone@example.com",
      consent: consented,
    });
    await eraseContact(s.account_id, erased.id);

    const csv = [
      "Email Address,Full Name,Phone",
      "anna.import@example.com,Anna,+36301112222",
      '"quoted@example.com","Kovács, Anna",',
      "ANNA.IMPORT@example.com,Duplicate,",
      "existing@example.com,Already Here,",
      "gone@example.com,Should Bounce,",
      "not-an-email,No At Sign,",
      ",,",
    ].join("\n");

    const result = await importContacts(s.account_id, csv, {
      status: "explicit_consent",
      statement: "newsletter checkbox at checkout since 2024",
    });

    expect(result.imported).toBe(2);
    // The fully blank ",," line never reaches the outcome loop — the
    // parser drops all-empty rows, so only the no-@ row counts invalid.
    expect(result.skipped).toEqual({
      suppressed: 1,
      already_exists: 1,
      duplicate_in_batch: 1,
      invalid: 1,
    });
    const suppressedRow = result.rows.find((r) => r.outcome === "suppressed");
    expect(suppressedRow && "reason" in suppressedRow && suppressedRow.reason).toBe("erasure");

    // Provenance: batch id + the owner's words on every imported row,
    // and the quoted comma-name parsed intact.
    const [quoted] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.account_id, s.account_id), eq(contacts.email, "quoted@example.com")));
    expect(quoted?.name).toBe("Kovács, Anna");
    expect(quoted?.consent_source).toContain(result.batch_id);
    expect(quoted?.consent_source).toContain("newsletter checkbox at checkout since 2024");
    expect(quoted?.consent_status).toBe("explicit_consent");

    // One log entry for the batch — and no PII anywhere in it.
    const entries = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.kind, "import")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ref_id).toBe(result.batch_id);
    const blob = JSON.stringify(entries);
    expect(blob).not.toContain("anna.import@example.com");
    expect(blob).not.toContain("quoted@example.com");
  });

  it("refuses an import with no attestation statement, and a headerless file", async () => {
    const s = await fresh();
    await expect(
      importContacts(s.account_id, "email\na@example.com", {
        status: "explicit_consent",
        statement: "   ",
      }),
    ).rejects.toThrow(/attestation/);
    await expect(
      importContacts(s.account_id, "colour,size\nred,large", {
        status: "unsure",
        statement: "trade fair fishbowl",
      }),
    ).rejects.toThrow(/no usable columns/);
  });
});
