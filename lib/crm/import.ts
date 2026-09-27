// Contact import — Phase 4 Session A (P4-03).
//
// A CSV never comes in without the owner standing behind it: every
// batch requires an ATTESTATION — the consent status these contacts
// hold and, in the owner's own words, how it was obtained ("checkout
// checkbox since 2024", "signed forms in the drawer"). The statement
// lands on every imported contact as its consent provenance, so a
// year from now any single row can say which batch it rode in on and
// what the owner claimed at the time (rule 19).
//
// The suppression list outranks the owner: an address that was erased
// or unsubscribed is refused re-entry by its reason, whatever the CSV
// says (rules 22/23). And the decision log records the BATCH — id,
// counts, a hash — never a contact's PII.
//
// The parser is deliberately small and deterministic: quoted fields,
// escaped quotes, flexible header names. No model anywhere near it —
// reading a spreadsheet is not inference (cost rule).

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contacts, decisionLog } from "../../db/schema";
import type { ConsentStatus } from "./contacts";
import { ContactError, isSuppressed, normalizeEmail } from "./contacts";

const MAX_ROWS = 10_000;
const MAX_BYTES = 2_000_000;

/* ── a small, honest CSV parser ── */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Header → column role, tolerant of the spellings spreadsheets grow. */
function mapHeader(header: string[]): { email: number; name: number; phone: number } {
  const find = (...names: string[]) =>
    header.findIndex((h) =>
      names.includes(
        h
          .trim()
          .toLowerCase()
          .replace(/[\s_-]+/g, ""),
      ),
    );
  return {
    email: find("email", "emailaddress", "e-mail", "mail"),
    name: find("name", "fullname", "contactname", "customer"),
    phone: find("phone", "phonenumber", "tel", "telephone", "mobile"),
  };
}

/* ── the import ── */

export interface ImportAttestation {
  status: ConsentStatus;
  /** The owner's words: what these contacts consented to, and how. */
  statement: string;
}

export type RowOutcome =
  | { outcome: "imported"; contact_id: string }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "already_exists" }
  | { outcome: "duplicate_in_batch" }
  | { outcome: "invalid"; reason: string };

export interface ImportResult {
  batch_id: string;
  imported: number;
  skipped: {
    suppressed: number;
    already_exists: number;
    duplicate_in_batch: number;
    invalid: number;
  };
  rows: RowOutcome[];
}

/**
 * Import a CSV of contacts under one attestation. Row-level honesty:
 * every line gets an outcome, nothing is silently dropped, and the
 * batch is one decision-log entry with counts and a hash — no PII.
 */
export async function importContacts(
  accountId: string,
  csv: string,
  attestation: ImportAttestation,
): Promise<ImportResult> {
  if (attestation.statement.trim() === "") {
    throw new ContactError(
      "an import needs your attestation — what did these contacts consent to, and how?",
      422,
    );
  }
  if (csv.length > MAX_BYTES) {
    throw new ContactError("that file is too large for one import — split it", 413);
  }
  const parsed = parseCsv(csv);
  if (parsed.length < 2) {
    throw new ContactError("the CSV needs a header row and at least one contact", 422);
  }
  if (parsed.length - 1 > MAX_ROWS) {
    throw new ContactError(`one import takes up to ${MAX_ROWS} rows — split the file`, 413);
  }
  const columns = mapHeader(parsed[0] as string[]);
  if (columns.email === -1 && columns.name === -1 && columns.phone === -1) {
    throw new ContactError(
      "no usable columns found — the header needs at least one of: email, name, phone",
      422,
    );
  }

  const batchId = crypto.randomUUID();
  const source = `import batch ${batchId}: "${attestation.statement.trim()}"`;
  const seenInBatch = new Set<string>();
  const rows: RowOutcome[] = [];
  const counts = { suppressed: 0, already_exists: 0, duplicate_in_batch: 0, invalid: 0 };
  let imported = 0;

  for (const raw of parsed.slice(1)) {
    const email = columns.email >= 0 ? (raw[columns.email] ?? "").trim() : "";
    const name = columns.name >= 0 ? (raw[columns.name] ?? "").trim() : "";
    const phone = columns.phone >= 0 ? (raw[columns.phone] ?? "").trim() : "";

    if (!email && !name && !phone) {
      counts.invalid++;
      rows.push({ outcome: "invalid", reason: "empty row" });
      continue;
    }
    if (email && !email.includes("@")) {
      counts.invalid++;
      rows.push({ outcome: "invalid", reason: "not an email address" });
      continue;
    }
    const normalized = email ? normalizeEmail(email) : null;
    if (normalized) {
      if (seenInBatch.has(normalized)) {
        counts.duplicate_in_batch++;
        rows.push({ outcome: "duplicate_in_batch" });
        continue;
      }
      seenInBatch.add(normalized);
      const suppressed = await isSuppressed(accountId, normalized);
      if (suppressed) {
        counts.suppressed++;
        rows.push({ outcome: "suppressed", reason: suppressed });
        continue;
      }
    }
    try {
      const [inserted] = await db
        .insert(contacts)
        .values({
          account_id: accountId,
          email: normalized,
          name: name || null,
          phone: phone || null,
          consent_status: attestation.status,
          consent_source: source,
        })
        .returning({ id: contacts.id });
      imported++;
      rows.push({ outcome: "imported", contact_id: inserted!.id });
    } catch (error) {
      const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint === "contacts_account_email_idx") {
        counts.already_exists++;
        rows.push({ outcome: "already_exists" });
        continue;
      }
      throw error;
    }
  }

  // The batch on the record — counts and a hash, no PII (rule 22).
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (profile) {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "import",
      ref_id: batchId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            account_id: accountId,
            batch_id: batchId,
            attestation_status: attestation.status,
            attestation_statement: attestation.statement.trim(),
            imported,
            ...counts,
          }),
        )
        .digest("hex"),
    });
  }
  console.log(
    JSON.stringify({
      event: "contacts_imported",
      account_id: accountId,
      batch_id: batchId,
      imported,
      ...counts,
    }),
  );
  return { batch_id: batchId, imported, skipped: counts, rows };
}
