// Deals — Phase 5 Session D (P5-14), rule 29: pipeline contacts are contacts.
//
// A deal is always WITH a Phase 4 contact. Adding one from /pipeline either
// links an existing contact (their consent is never touched) or creates one
// through the contact spine's own door (lib/crm/contacts addContact), so a
// suppressed address is refused re-entry by its reason, as everywhere, and
// a new contact lands as `unsure` with its provenance in words: a sales
// conversation is not marketing consent (rule 19). Erasing the contact
// erases the deal, its history and any drafted follow-up by cascade
// (db/schema.ts), and the decision log is never touched by it (rule 22).
//
// Every change is recorded beside the deal in deal_events, what it was and
// what it became, so moving a deal on never loses its past (rule 3's
// spirit) and stage ageing and the measured win rate read from real dates.
// Values are integer minor units plus currency plus whether they were
// quoted or estimated, together or not at all (rules 1 and 2).
//
// Who has a pipeline is data (rule 4): PIPELINE_APPLIES over 6.1a. A
// business that sells only to consumers can't add a deal.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { contacts, dealEvents, deals } from "../../db/schema";
import { evaluate } from "../conditions/evaluate";
import type { Money } from "../core/money";
import { isIsoCurrency, money } from "../core/money";
import { buildConditionContext } from "../resolver/applicability";
import type { ContactRow } from "../crm/contacts";
import { ContactError, addContact, normalizeEmail } from "../crm/contacts";
import type { DealFacts } from "./maths";
import type { DealStage } from "./stages";
import { PIPELINE_APPLIES, STAGE_LABELS, isDealStage, isOpenStage } from "./stages";

export class DealError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DealError";
    this.status = status;
  }
}

export type DealRow = typeof deals.$inferSelect;
export type ValueBasis = "quoted" | "estimated";

export const NOT_B2B =
  "Your pipeline is for businesses that sell to other businesses: you told me you sell to consumers (6.1a).";

/** Who the pipeline exists for — 6.1a is b2b or both, by the condition in data. */
export async function pipelineApplies(profileId: string): Promise<boolean> {
  return evaluate(PIPELINE_APPLIES, await buildConditionContext(profileId));
}

export interface DealValueInput {
  amount_minor: number;
  currency: string;
  basis: ValueBasis;
}

export interface NewDeal {
  /** An existing contact of this account, or who the deal is with. */
  contact: { id: string } | { name?: string | null; email?: string | null; phone?: string | null };
  company?: string | null;
  title: string;
  stage?: DealStage;
  value?: DealValueInput | null;
  expected_close?: string | null;
  next_step?: string | null;
  next_step_due?: string | null;
  last_contact_at?: string | null;
}

export interface DealOrigin {
  source: "owner_input" | "import";
  /** "added on /pipeline", or the import batch with the owner's attestation. */
  note: string;
  /** For an import: the batch's consent attestation, applied to contacts it creates. */
  attestation?: { status: ContactRow["consent_status"]; source: string };
}

const TITLE_MAX = 200;
const TEXT_MAX = 500;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(v: string): boolean {
  return ISO_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function cleanText(v: string | null | undefined, max: number, label: string): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  if (t.length > max) throw new DealError(`${label} is too long (${max} characters at most)`, 422);
  return t;
}

/** Validate a value: whole minor units, not negative, an ISO currency, a basis (rules 1, 2). */
export function checkValue(v: DealValueInput | null | undefined): DealValueInput | null {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v.amount_minor) || v.amount_minor < 0) {
    throw new DealError("a deal's value is a whole amount in minor units, never negative", 422);
  }
  const currency = v.currency.trim().toUpperCase();
  if (!isIsoCurrency(currency)) {
    throw new DealError("a deal's value needs its currency (three letters, e.g. EUR)", 422);
  }
  if (v.basis !== "quoted" && v.basis !== "estimated") {
    throw new DealError("say whether the value was quoted to them or is your estimate", 422);
  }
  return { amount_minor: v.amount_minor, currency, basis: v.basis };
}

function checkDay(v: string | null | undefined, label: string): string | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  if (!isDay(v.trim())) throw new DealError(`${label} must be a date (YYYY-MM-DD)`, 422);
  return v.trim();
}

/** The contact a new deal is with: an existing one of this account, found by email, or created. */
async function resolveContact(
  accountId: string,
  who: NewDeal["contact"],
  origin: DealOrigin,
  today: string,
): Promise<ContactRow> {
  if ("id" in who) {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, who.id), eq(contacts.account_id, accountId)));
    if (!row) throw new DealError("no such contact", 404);
    return row;
  }
  const email = who.email?.trim() ? normalizeEmail(who.email) : null;
  if (email) {
    const [existing] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.account_id, accountId), eq(contacts.email, email)));
    if (existing) return existing; // consent stays exactly as recorded
  }
  try {
    return await addContact(accountId, {
      email,
      name: who.name ?? null,
      phone: who.phone ?? null,
      consent: origin.attestation ?? {
        status: "unsure",
        source: `added as a deal contact on /pipeline ${today} — a sales conversation is not marketing consent`,
      },
    });
  } catch (error) {
    if (error instanceof ContactError) throw new DealError(error.message, error.status);
    throw error;
  }
}

/** Add a deal. Its first event records what it was created as. */
export async function addDeal(
  accountId: string,
  profileId: string,
  input: NewDeal,
  origin: DealOrigin = { source: "owner_input", note: "added on /pipeline" },
  now: Date = new Date(),
): Promise<DealRow> {
  if (!(await pipelineApplies(profileId))) throw new DealError(NOT_B2B, 409);
  return insertDeal(accountId, profileId, input, origin, now);
}

/**
 * addDeal without the PIPELINE_APPLIES check — for the import, which checks
 * it once for the whole file. Every other caller uses addDeal.
 */
export async function insertDeal(
  accountId: string,
  profileId: string,
  input: NewDeal,
  origin: DealOrigin,
  now: Date,
): Promise<DealRow> {
  const title = cleanText(input.title, TITLE_MAX, "the deal's name");
  if (title === null) throw new DealError("a deal needs a name — what is it for?", 422);
  const stage = input.stage ?? "lead";
  if (!isDealStage(stage)) throw new DealError("that isn't a pipeline stage", 422);
  const value = checkValue(input.value);
  const nextStep = cleanText(input.next_step, TEXT_MAX, "the next step");
  const due = checkDay(input.next_step_due, "the next step's date");
  if (due !== null && nextStep === null) {
    throw new DealError("a date needs a next step to go with it", 422);
  }
  const expectedClose = checkDay(input.expected_close, "the expected close");
  const lastContactDay = checkDay(input.last_contact_at?.slice(0, 10), "the last contact");
  const at = now.toISOString();
  if (lastContactDay !== null && lastContactDay > at.slice(0, 10)) {
    throw new DealError("the last time you spoke to them can't be in the future", 422);
  }
  const company = cleanText(input.company, TITLE_MAX, "the company");
  const contact = await resolveContact(accountId, input.contact, origin, at.slice(0, 10));

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(deals)
      .values({
        account_id: accountId,
        profile_id: profileId,
        contact_id: contact.id,
        company,
        title,
        stage,
        stage_entered_at: at,
        value_minor: value?.amount_minor ?? null,
        value_currency: value?.currency ?? null,
        value_basis: value?.basis ?? null,
        expected_close: expectedClose,
        next_step: nextStep,
        next_step_due: due,
        last_contact_at: lastContactDay ? `${lastContactDay}T12:00:00.000Z` : null,
        source: origin.source,
        source_note: origin.note,
        closed_at: isOpenStage(stage) ? null : at,
        created_at: at,
        updated_at: at,
      })
      .returning();
    if (!row) throw new DealError("the deal could not be stored", 500);
    await tx.insert(dealEvents).values({
      deal_id: row.id,
      account_id: accountId,
      kind: "created",
      before: null,
      after: { stage, value, next_step: nextStep, next_step_due: due },
      source: origin.source,
      at,
    });
    return row;
  });
}

export interface DealChange {
  stage?: DealStage;
  value?: DealValueInput | null;
  next_step?: { text: string | null; due: string | null };
  expected_close?: string | null;
  /** The owner spoke to them: on this day (YYYY-MM-DD), or today. */
  contacted?: { on?: string | null };
}

/**
 * Change a deal. Each part that changes writes an event with the old and
 * the new; a change to the same stage is refused, so the stage's clock
 * never resets by accident.
 */
export async function updateDeal(
  accountId: string,
  dealId: string,
  change: DealChange,
  now: Date = new Date(),
): Promise<DealRow> {
  const at = now.toISOString();
  const today = at.slice(0, 10);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.account_id, accountId)))
      .for("update");
    if (!row) throw new DealError("no such deal", 404);
    const set: Partial<typeof deals.$inferInsert> = { updated_at: at };
    const events: { kind: string; before: unknown; after: unknown }[] = [];

    if (change.stage !== undefined) {
      if (!isDealStage(change.stage)) throw new DealError("that isn't a pipeline stage", 422);
      if (change.stage === row.stage) {
        throw new DealError(`it's already ${STAGE_LABELS[row.stage].toLowerCase()}`, 409);
      }
      set.stage = change.stage;
      set.stage_entered_at = at;
      set.closed_at = isOpenStage(change.stage) ? null : at;
      events.push({
        kind: "stage",
        before: { stage: row.stage, entered_at: row.stage_entered_at },
        after: { stage: change.stage },
      });
    }
    if (change.value !== undefined) {
      const value = checkValue(change.value);
      set.value_minor = value?.amount_minor ?? null;
      set.value_currency = value?.currency ?? null;
      set.value_basis = value?.basis ?? null;
      events.push({ kind: "value", before: valueOf(row), after: value });
    }
    if (change.next_step !== undefined) {
      const text = cleanText(change.next_step.text, TEXT_MAX, "the next step");
      const due = checkDay(change.next_step.due, "the next step's date");
      if (due !== null && text === null) {
        throw new DealError("a date needs a next step to go with it", 422);
      }
      set.next_step = text;
      set.next_step_due = due;
      events.push({
        kind: "next_step",
        before: { text: row.next_step, due: row.next_step_due },
        after: { text, due },
      });
    }
    if (change.expected_close !== undefined) {
      const day = checkDay(change.expected_close, "the expected close");
      set.expected_close = day;
      events.push({ kind: "expected_close", before: row.expected_close, after: day });
    }
    if (change.contacted !== undefined) {
      const day = checkDay(change.contacted.on ?? null, "the day you spoke to them") ?? today;
      if (day > today) throw new DealError("that day hasn't happened yet", 422);
      const when = day === today ? at : `${day}T12:00:00.000Z`;
      set.last_contact_at = when;
      events.push({ kind: "contacted", before: row.last_contact_at, after: when });
    }
    if (events.length === 0) throw new DealError("nothing to change", 422);

    const [updated] = await tx.update(deals).set(set).where(eq(deals.id, row.id)).returning();
    for (const e of events) {
      await tx.insert(dealEvents).values({
        deal_id: row.id,
        account_id: accountId,
        kind: e.kind,
        before: e.before ?? null,
        after: e.after ?? null,
        source: "owner_input",
        at,
      });
    }
    console.log(
      JSON.stringify({
        event: "deal_changed",
        account_id: accountId,
        deal_id: row.id,
        changed: events.map((e) => e.kind),
      }),
    );
    return updated as DealRow;
  });
}

function valueOf(row: DealRow): DealValueInput | null {
  return row.value_minor === null || row.value_currency === null || row.value_basis === null
    ? null
    : {
        amount_minor: row.value_minor,
        currency: row.value_currency,
        basis: row.value_basis as ValueBasis,
      };
}

/** A deal's value as Money, when it has one. */
export function dealValue(row: DealRow): Money | null {
  return row.value_minor === null || row.value_currency === null
    ? null
    : money(row.value_minor, row.value_currency);
}

/** What the pure maths reads from a row. */
export function dealFacts(row: DealRow): DealFacts {
  return {
    id: row.id,
    stage: row.stage,
    stage_entered_at: row.stage_entered_at,
    created_at: row.created_at,
    closed_at: row.closed_at,
    last_contact_at: row.last_contact_at,
    value: dealValue(row),
    value_basis: (row.value_basis as ValueBasis | null) ?? null,
    next_step: row.next_step,
    next_step_due: row.next_step_due,
  };
}

export interface DealWithContact {
  deal: DealRow;
  contact: Pick<ContactRow, "id" | "name" | "email" | "phone" | "consent_status">;
}

/** The profile's deals with who they are with, oldest first. */
export async function listDeals(profileId: string): Promise<DealWithContact[]> {
  const rows = await db
    .select({
      deal: deals,
      contact: {
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        phone: contacts.phone,
        consent_status: contacts.consent_status,
      },
    })
    .from(deals)
    .innerJoin(contacts, eq(contacts.id, deals.contact_id))
    .where(eq(deals.profile_id, profileId))
    .orderBy(asc(deals.created_at), asc(deals.id));
  return rows;
}
