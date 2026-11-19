// Deals from a CSV — Phase 5 Session D (P5-17), under P4-03's attestation.
//
// A deals file brings people with it, so it comes in exactly as a contacts
// file does (lib/crm/import): the owner attests, on the record, what the
// people in it consented to and how. Every contact the file CREATES lands
// under that attestation with the batch id in its provenance; a contact
// already on the books is linked and its consent never moves; a suppressed
// address is refused by its reason, whatever the file says (rules 19, 22,
// 23, 29). The batch is one decision-log entry — counts and a hash, no PII.
//
// Reading is deterministic and honest: a value that can't be read, a date
// that isn't one, a stage that isn't a stage — left out and counted, never
// guessed. An empty stage is a lead, as on the screen. Values come in as the
// owner's estimate unless the owner says the column holds quotes (rule 2).
// The same deal twice (same contact, same name) is skipped, so importing a
// file again adds nothing.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { contacts, decisionLog, deals } from "../../db/schema";
import type { ConsentStatus } from "../crm/contacts";
import { ContactError, addContact, isSuppressed, normalizeEmail } from "../crm/contacts";
import { parseCsv, parseDate, parseMoneyMinor } from "../crm/import";
import { isIsoCurrency } from "../core/money";
import type { ValueBasis } from "./deals";
import { DealError, NOT_B2B, insertDeal, pipelineApplies } from "./deals";
import type { DealStage } from "./stages";

const MAX_ROWS = 2_000;
const MAX_BYTES = 1_000_000;

export interface DealImportAttestation {
  status: ConsentStatus;
  /** The owner's words: what the people in this file consented to, and how. */
  statement: string;
}

export interface DealImportOptions {
  /** ISO 4217 for the value column. Required when the file has one. */
  currency?: string;
  /** What the value column holds. Defaults to the owner's estimate. */
  value_basis?: ValueBasis;
  now?: Date;
}

export type DealRowOutcome =
  | { outcome: "imported"; deal_id: string; contact: "created" | "linked" }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "already_exists" }
  | { outcome: "invalid"; reason: string };

export interface DealImportResult {
  batch_id: string;
  imported: number;
  contacts_created: number;
  contacts_linked: number;
  skipped: { suppressed: number; already_exists: number; invalid: number };
  /** Cells that couldn't be read and were left empty, by column. */
  unreadable: { value: number; stage: number; dates: number };
  rows: DealRowOutcome[];
}

interface Columns {
  company: number;
  name: number;
  email: number;
  phone: number;
  title: number;
  stage: number;
  value: number;
  expected_close: number;
  next_step: number;
  next_step_due: number;
  last_contact: number;
}

const squash = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

function mapHeader(header: string[]): Columns {
  const find = (...names: string[]) => header.findIndex((h) => names.includes(squash(h)));
  return {
    company: find("company", "companyname", "organisation", "organization", "business", "account"),
    name: find("name", "contact", "contactname", "fullname", "person"),
    email: find("email", "emailaddress", "e-mail", "contactemail"),
    phone: find("phone", "phonenumber", "tel", "telephone", "mobile"),
    title: find("deal", "dealname", "title", "opportunity", "opportunityname", "dealtitle"),
    stage: find("stage", "dealstage", "status", "pipelinestage"),
    value: find("value", "dealvalue", "amount", "dealamount", "worth"),
    expected_close: find("expectedclose", "closedate", "expectedclosedate", "closeby"),
    next_step: find("nextstep", "nextaction", "todo"),
    next_step_due: find("nextstepdue", "nextstepdate", "duedate", "due", "nextactiondate"),
    last_contact: find(
      "lastcontact",
      "lastcontacted",
      "lastspoke",
      "lastactivity",
      "lastcontactdate",
    ),
  };
}

const STAGE_WORDS: Readonly<Record<string, DealStage>> = {
  lead: "lead",
  new: "lead",
  enquiry: "lead",
  inquiry: "lead",
  qualified: "qualified",
  proposalsent: "proposal_sent",
  proposal: "proposal_sent",
  quotesent: "proposal_sent",
  quoted: "proposal_sent",
  won: "won",
  closedwon: "won",
  lost: "lost",
  closedlost: "lost",
};

/** A stage as people write it, or null when it isn't one; empty is a lead. */
export function parseStage(raw: string): DealStage | null {
  const v = squash(raw);
  if (v === "") return "lead";
  return STAGE_WORDS[v] ?? null;
}

export async function importDeals(
  accountId: string,
  profileId: string,
  csv: string,
  attestation: DealImportAttestation,
  options: DealImportOptions = {},
): Promise<DealImportResult> {
  if (!(await pipelineApplies(profileId))) throw new DealError(NOT_B2B, 409);
  if (attestation.statement.trim() === "") {
    throw new DealError(
      "an import needs your attestation — what did the people in this file consent to, and how?",
      422,
    );
  }
  if (csv.length > MAX_BYTES) {
    throw new DealError("that file is too large for one import: split it", 413);
  }
  const parsed = parseCsv(csv);
  if (parsed.length < 2) {
    throw new DealError("the CSV needs a header row and at least one deal", 422);
  }
  if (parsed.length - 1 > MAX_ROWS) {
    throw new DealError(`one import takes up to ${MAX_ROWS} deals — split the file`, 413);
  }
  const columns = mapHeader(parsed[0] as string[]);
  if (columns.title === -1) {
    throw new DealError("the header needs a deal column — what each deal is for", 422);
  }
  if (columns.company === -1 && columns.name === -1 && columns.email === -1) {
    throw new DealError("the header needs who each deal is with: a company, name or email", 422);
  }
  const currency = options.currency?.trim().toUpperCase() ?? "";
  if (columns.value !== -1 && !isIsoCurrency(currency)) {
    throw new DealError(
      "the file has a value column — say which currency it is in (three letters, e.g. EUR)",
      422,
    );
  }
  const basis: ValueBasis = options.value_basis ?? "estimated";
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const batchId = crypto.randomUUID();
  const note = `import batch ${batchId}: "${attestation.statement.trim()}"`;
  const rows: DealRowOutcome[] = [];
  const skipped = { suppressed: 0, already_exists: 0, invalid: 0 };
  const unreadable = { value: 0, stage: 0, dates: 0 };
  let imported = 0;
  let created = 0;
  let linked = 0;

  for (const raw of parsed.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (raw[i] ?? "").trim() : "");
    const title = cell(columns.title);
    const company = cell(columns.company);
    const name = cell(columns.name);
    const email = cell(columns.email);
    const phone = cell(columns.phone);
    if (title === "") {
      skipped.invalid++;
      rows.push({ outcome: "invalid", reason: "no deal name" });
      continue;
    }
    if (!company && !name && !email && !phone) {
      skipped.invalid++;
      rows.push({ outcome: "invalid", reason: "nobody to have the deal with" });
      continue;
    }
    if (email && !email.includes("@")) {
      skipped.invalid++;
      rows.push({ outcome: "invalid", reason: "not an email address" });
      continue;
    }
    const stage = parseStage(cell(columns.stage));
    if (stage === null) {
      unreadable.stage++;
      skipped.invalid++;
      rows.push({ outcome: "invalid", reason: "the stage isn't one of the pipeline's" });
      continue;
    }

    // Who: an existing contact keeps its consent; a suppressed address is refused.
    const normalized = email ? normalizeEmail(email) : null;
    let contactId: string | null = null;
    let how: "created" | "linked" = "linked";
    if (normalized) {
      const [existing] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.account_id, accountId), eq(contacts.email, normalized)));
      if (existing) contactId = existing.id;
      else {
        const suppressed = await isSuppressed(accountId, normalized);
        if (suppressed) {
          skipped.suppressed++;
          rows.push({ outcome: "suppressed", reason: suppressed });
          continue;
        }
      }
    }
    if (contactId === null && normalized === null) {
      // No address to match on: the same deal name with the same company and
      // contact name is the same deal, so a re-imported file adds nothing.
      const who = (name || company).toLowerCase();
      const [dup] = await db
        .select({ id: deals.id })
        .from(deals)
        .innerJoin(contacts, eq(contacts.id, deals.contact_id))
        .where(
          and(
            eq(deals.profile_id, profileId),
            sql`lower(${deals.title}) = ${title.toLowerCase()}`,
            sql`coalesce(lower(${deals.company}), '') = ${company.toLowerCase()}`,
            sql`coalesce(lower(${contacts.name}), '') = ${who}`,
          ),
        );
      if (dup) {
        skipped.already_exists++;
        rows.push({ outcome: "already_exists" });
        continue;
      }
    }
    if (contactId !== null) {
      const [dup] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.profile_id, profileId),
            eq(deals.contact_id, contactId),
            sql`lower(${deals.title}) = ${title.toLowerCase()}`,
          ),
        );
      if (dup) {
        skipped.already_exists++;
        rows.push({ outcome: "already_exists" });
        continue;
      }
    }

    // What: read what can be read, count what can't, invent nothing.
    const valueRaw = cell(columns.value);
    const minor = valueRaw ? parseMoneyMinor(valueRaw, currency) : null;
    if (valueRaw && (minor === null || minor < 0)) unreadable.value++;
    const day = (i: number): string | null => {
      const v = cell(i);
      if (!v) return null;
      const d = parseDate(v);
      if (d === null) unreadable.dates++;
      return d?.slice(0, 10) ?? null;
    };
    const expectedClose = day(columns.expected_close);
    const nextStep = cell(columns.next_step) || null;
    let due = day(columns.next_step_due);
    if (due !== null && nextStep === null) {
      unreadable.dates++;
      due = null;
    }
    let lastContact = day(columns.last_contact);
    if (lastContact !== null && lastContact > today) {
      unreadable.dates++;
      lastContact = null;
    }

    try {
      if (contactId === null) {
        const contact = await addContact(accountId, {
          email: normalized,
          name: name || company || null,
          phone: phone || null,
          consent: { status: attestation.status, source: note },
        });
        contactId = contact.id;
        how = "created";
      }
      const deal = await insertDeal(
        accountId,
        profileId,
        {
          contact: { id: contactId },
          company: company || null,
          title,
          stage,
          value: minor !== null && minor >= 0 ? { amount_minor: minor, currency, basis } : null,
          expected_close: expectedClose,
          next_step: nextStep,
          next_step_due: due,
          last_contact_at: lastContact,
        },
        { source: "import", note },
        now,
      );
      imported++;
      if (how === "created") created++;
      else linked++;
      rows.push({ outcome: "imported", deal_id: deal.id, contact: how });
    } catch (error) {
      if (error instanceof DealError || error instanceof ContactError) {
        skipped.invalid++;
        rows.push({ outcome: "invalid", reason: error.message });
        continue;
      }
      throw error;
    }
  }

  // The batch on the record — counts and a hash, no PII (rule 22).
  await db.insert(decisionLog).values({
    profile_id: profileId,
    actor: "owner",
    kind: "import",
    ref_id: batchId,
    payload_hash: createHash("sha256")
      .update(
        JSON.stringify({
          account_id: accountId,
          batch_id: batchId,
          kind: "deals",
          attestation_status: attestation.status,
          attestation_statement: attestation.statement.trim(),
          imported,
          contacts_created: created,
          contacts_linked: linked,
          ...skipped,
        }),
      )
      .digest("hex"),
  });
  console.log(
    JSON.stringify({
      event: "deals_imported",
      account_id: accountId,
      batch_id: batchId,
      imported,
      contacts_created: created,
      contacts_linked: linked,
      ...skipped,
      unreadable,
    }),
  );
  return {
    batch_id: batchId,
    imported,
    contacts_created: created,
    contacts_linked: linked,
    skipped,
    unreadable,
    rows,
  };
}
