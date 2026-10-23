// The knowledge base, the OWNER side — Phase 4 Session B (P4-05).
//
// What the support assistant may say is seeded by PROPOSALS: this module
// renders candidate answers from profile facts the owner already gave —
// opening hours, the refund policy, what an offer costs — into plain
// question-and-answer pairs, deterministically (no model), and puts them
// in the approval queue as ONE proposal. Approval publishes them;
// nothing unapproved becomes a knowledge_entries row, and the support
// tier can only ever read rows (lib/support/knowledge.ts).
//
// Why a closed template list and not "everything in the profile": the
// profile holds margins, costs, debt, staff — facts a customer must
// never hear. The allowlist below is the whole of what can be proposed
// from facts; anything else enters only as an owner-written entry,
// through the same queue. Every entry names the field keys it was
// rendered from (rule 2), so a changed fact can be re-proposed and the
// old entry retired.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import type { DbTx } from "../../db";
import { knowledgeEntries, offers, proposals } from "../../db/schema";
import type { Field } from "../core/field";
import { repr } from "../profile/factsheet";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits } from "../proposals/hard-limits";
import { createProposal, recordExecution } from "../proposals/service";
import type { KnowledgeEntryRow } from "../support/knowledge";

export class KnowledgeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "KnowledgeError";
    this.status = status;
  }
}

export const KNOWLEDGE_MODULE = "support";
export const KNOWLEDGE_KIND = "support_knowledge";
export const KNOWLEDGE_EXPIRY_DAYS = 14;

export interface KnowledgeCandidate {
  question: string;
  answer: string;
  /** Field keys the answer was rendered from; ["owner:written"] for a hand-written entry. */
  source_keys: string[];
}

function yesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["yes", "true", "y"].includes(v)) return true;
  if (["no", "false", "n"].includes(v)) return false;
  return null;
}

interface FactTemplate {
  key: string;
  question: (name: string) => string;
  answer: (value: string, name: string) => string | null;
}

/** The allowlist: the only profile facts that can become public answers. */
export const FACT_TEMPLATES: readonly FactTemplate[] = [
  {
    key: "identity.legal_name",
    question: () => "What is the business called?",
    answer: (v) => `${v}.`,
  },
  {
    key: "identity.description",
    question: (name) => `What does ${name} do?`,
    answer: (v) => v,
  },
  {
    key: "presence.opening_hours",
    question: () => "What are your opening hours?",
    answer: (v) => `Our opening hours: ${v}.`,
  },
  {
    key: "presence.website_url",
    question: () => "Where can I find you online?",
    answer: (v) => `Our website is ${v}.`,
  },
  {
    key: "presence.sells_on_website",
    question: () => "Can I buy directly on your website?",
    answer: (v) => {
      const b = yesNo(v);
      if (b === null) return null;
      return b
        ? "Yes — you can buy directly on our website."
        : "Not directly on the website — get in touch and we'll sort it out.";
    },
  },
  {
    key: "presence.market_scope",
    question: () => "Where do you sell or deliver to?",
    answer: (v) => `We sell ${v}.`,
  },
  {
    key: "fulfilment.ships_products",
    question: () => "Do you ship products?",
    answer: (v) => {
      const b = yesNo(v);
      if (b === null) return null;
      return b ? "Yes, we ship products to customers." : "We don't ship products.";
    },
  },
  {
    key: "fulfilment.shipping_providers",
    question: () => "Which carriers do you ship with?",
    answer: (v) => `We ship with ${v}.`,
  },
  {
    key: "fulfilment.shipping_paid_by",
    question: () => "Who pays for shipping?",
    answer: (v) => `Shipping is paid by ${v}.`,
  },
  {
    key: "fulfilment.local_delivery",
    question: () => "Do you deliver locally?",
    answer: (v) => {
      const b = yesNo(v);
      if (b === null) return null;
      return b ? "Yes, we deliver locally ourselves." : "We don't offer local delivery.";
    },
  },
  {
    key: "service.uses_booking",
    question: () => "Can I book an appointment?",
    answer: (v) => {
      const b = yesNo(v);
      if (b === null) return null;
      return b ? "Yes — appointments can be booked." : "We don't take appointments.";
    },
  },
  {
    key: "service.booking_tool",
    question: () => "How do I book?",
    answer: (v) => `Bookings: ${v}.`,
  },
  {
    key: "revenue.payment.methods",
    question: () => "How can I pay?",
    answer: (v) => `You can pay by ${v}.`,
  },
  {
    key: "revenue.payment.refund_policy",
    question: () => "What is your refund policy?",
    answer: (v) => v,
  },
];

export const PUBLIC_FACT_KEYS: readonly string[] = FACT_TEMPLATES.map((t) => t.key);

/** A current, answered value rendered the fact sheet's way; null when there is nothing to say. */
function answered(field: Field<unknown> | null): string | null {
  if (!field) return null;
  if (field.status !== "answered" && field.status !== "inferred") return null;
  const v = repr(field.value);
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

async function current(profileId: string, key: string): Promise<string | null> {
  return answered(await readCurrentField<unknown>(profileId, key));
}

/**
 * Candidates rendered from the profile — the deterministic half of P4-05.
 * Reads ONLY the allowlisted keys and the offer fields named below; the
 * rest of the profile is never loaded here, let alone rendered.
 */
export async function knowledgeCandidates(profileId: string): Promise<KnowledgeCandidate[]> {
  const name = (await current(profileId, "identity.legal_name")) ?? "the business";

  const out: KnowledgeCandidate[] = [];
  for (const t of FACT_TEMPLATES) {
    const value = await current(profileId, t.key);
    if (value === null) continue;
    const answer = t.answer(value, name);
    if (answer === null) continue;
    out.push({ question: t.question(name), answer, source_keys: [t.key] });
  }

  const rows = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId))
    .orderBy(offers.id);
  for (const { id } of rows) {
    const prefix = `offers.${id}`;
    const offerName = await current(profileId, `${prefix}.name`);
    if (offerName === null) continue;
    const price = await current(profileId, `${prefix}.price`);
    const description = await current(profileId, `${prefix}.description`);
    const priceModel = await current(profileId, `${prefix}.price_model`);
    const keys = [`${prefix}.name`];
    const parts: string[] = [];
    if (description) {
      parts.push(description.endsWith(".") ? description : `${description}.`);
      keys.push(`${prefix}.description`);
    }
    if (price) {
      parts.push(`${offerName} costs ${price}${priceModel ? ` (${priceModel})` : ""}.`);
      keys.push(`${prefix}.price`);
      if (priceModel) keys.push(`${prefix}.price_model`);
    }
    if (parts.length === 0) continue;
    out.push({
      question: price ? `What is ${offerName} and how much does it cost?` : `What is ${offerName}?`,
      answer: parts.join(" "),
      source_keys: keys,
    });
  }
  return out;
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((k, i) => k === [...b].sort()[i]);

/** Candidates not already public and not already waiting in the queue. */
async function fresh(
  profileId: string,
  candidates: KnowledgeCandidate[],
): Promise<KnowledgeCandidate[]> {
  const live = await db
    .select({
      question: knowledgeEntries.question,
      answer: knowledgeEntries.answer,
      source_keys: knowledgeEntries.source_keys,
    })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.profile_id, profileId), eq(knowledgeEntries.status, "public")));
  const pending = await pendingKnowledgeProposals(profileId);
  const queued = pending.flatMap((p) => entriesOf(p));
  return candidates.filter((c) => {
    const unchanged = live.some(
      (e) => sameKeys(e.source_keys, c.source_keys) && e.answer === c.answer,
    );
    const waiting = queued.some((e) => sameKeys(e.source_keys, c.source_keys));
    return !unchanged && !waiting;
  });
}

type ProposalRow = typeof proposals.$inferSelect;

export function entriesOf(proposal: ProposalRow): KnowledgeCandidate[] {
  const detail = (proposal.action as { detail?: { entries?: unknown } } | null)?.detail;
  if (!detail || !Array.isArray(detail.entries)) return [];
  return detail.entries.filter(
    (e): e is KnowledgeCandidate =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as KnowledgeCandidate).question === "string" &&
      typeof (e as KnowledgeCandidate).answer === "string" &&
      Array.isArray((e as KnowledgeCandidate).source_keys),
  );
}

async function pendingKnowledgeProposals(profileId: string): Promise<ProposalRow[]> {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, KNOWLEDGE_MODULE),
        eq(proposals.status, "pending"),
      ),
    );
  return rows.filter((p) => (p.action as { kind?: string }).kind === KNOWLEDGE_KIND);
}

/** The one way entries enter the queue — facts, owner-written, and the FAQ (P4-12) all come through here. */
export async function proposeEntries(
  profileId: string,
  entries: KnowledgeCandidate[],
  summary: string,
  limitLlm: LimitLlm | undefined,
): Promise<ProposalRow> {
  return propose(profileId, entries, summary, limitLlm);
}

async function propose(
  profileId: string,
  entries: KnowledgeCandidate[],
  summary: string,
  limitLlm: LimitLlm | undefined,
  tx?: DbTx,
): Promise<ProposalRow> {
  const { limits } = await ensureHardLimits(profileId, limitLlm);
  const verdict = checkHardLimits(limits, KNOWLEDGE_KIND);
  return createProposal(
    {
      profile_id: profileId,
      module: KNOWLEDGE_MODULE,
      originating_finding: null,
      action: {
        kind: KNOWLEDGE_KIND,
        summary,
        detail: {
          rationale:
            "The customer assistant answers ONLY from entries you approve. These are rendered from facts you already gave; nothing here is guessed.",
          entries,
          manual_limits: verdict.manual.map((l) => l.quote),
        },
      },
      scenario: {
        assumptions: [
          {
            statement:
              "Each answer is rendered from a fact you gave in the intake, or written by you",
            value: null,
            source_field: null,
            sensitivity: "low",
          },
        ],
        base_case: {
          case: "base",
          statement:
            "Customers asking these questions get an immediate, accurate answer on your site.",
          profit_delta_monthly: null,
          formula: null,
        },
        downside_case: {
          case: "downside",
          statement:
            "An answer goes stale when a fact changes — retire it and re-propose; the assistant stops saying it at once.",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: {
          case: "upside",
          statement:
            "Fewer repeat questions reach you; your support page will show which ones it answers.",
          profit_delta_monthly: null,
          formula: null,
        },
        breakeven_condition: "not computed — publishing answers carries no spend",
      } as never,
      reversibility: {
        level: "easy",
        if_you_change_your_mind:
          "Retire any entry on the support screen; the assistant stops using it immediately.",
      },
      expires_at: new Date(Date.now() + KNOWLEDGE_EXPIRY_DAYS * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? verdict.limit.quote : null,
    },
    tx,
  );
}

/** Suggest entries from facts, as one proposal. 422 when there is nothing new. */
export async function proposeKnowledgeEntries(
  profileId: string,
  opts: { limitLlm?: LimitLlm } = {},
): Promise<ProposalRow> {
  const candidates = await fresh(profileId, await knowledgeCandidates(profileId));
  if (candidates.length === 0) {
    throw new KnowledgeError(
      "nothing new to propose — every answer the profile supports is already public or already in your queue",
      422,
    );
  }
  return propose(
    profileId,
    candidates,
    `Publish ${candidates.length} answer${candidates.length === 1 ? "" : "s"} the customer assistant may give`,
    opts.limitLlm,
  );
}

/** An owner-written entry — same queue, same log, so the record says who put words in the assistant's mouth. */
export async function proposeCustomKnowledge(
  profileId: string,
  input: { question: string; answer: string },
  /** tx: join the caller's transaction (the chat's confirm, review 2026-10-23 #21). */
  opts: { limitLlm?: LimitLlm; tx?: DbTx } = {},
): Promise<ProposalRow> {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (question.length < 3 || answer.length < 2) {
    throw new KnowledgeError("a question and an answer are both required", 422);
  }
  if (question.length > 300 || answer.length > 2000) {
    throw new KnowledgeError(
      "keep the question under 300 characters and the answer under 2000",
      422,
    );
  }
  return propose(
    profileId,
    [{ question, answer, source_keys: ["owner:written"] }],
    `Publish an answer you wrote: "${question.length > 60 ? `${question.slice(0, 57)}…` : question}"`,
    opts.limitLlm,
    opts.tx,
  );
}

/**
 * An APPROVED knowledge proposal becomes public entries. Mirrors content
 * production: internal, not an external write, so it does not pass the
 * engine — but the proposal flips to executed through the Session A
 * service, which writes the decision-log entry.
 */
export async function publishKnowledgeFromProposal(
  proposalId: string,
  opts: { expectedProfileId?: string } = {},
): Promise<KnowledgeEntryRow[]> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal) throw new KnowledgeError("no such proposal", 404);
  if (opts.expectedProfileId && proposal.profile_id !== opts.expectedProfileId) {
    throw new KnowledgeError("no such proposal", 404);
  }
  if (
    proposal.module !== KNOWLEDGE_MODULE ||
    (proposal.action as { kind?: string }).kind !== KNOWLEDGE_KIND
  ) {
    throw new KnowledgeError("this proposal is not a knowledge proposal", 422);
  }
  if (proposal.status !== "approved") {
    throw new KnowledgeError(
      `only an approved proposal publishes — this one is ${proposal.status}`,
      409,
    );
  }
  const entries = entriesOf(proposal);
  if (entries.length === 0) throw new KnowledgeError("the proposal carried no entries", 422);

  const inserted = await db
    .insert(knowledgeEntries)
    .values(
      entries.map((e) => ({
        profile_id: proposal.profile_id,
        proposal_id: proposal.id,
        question: e.question,
        answer: e.answer,
        source_keys: e.source_keys,
      })),
    )
    .returning();
  // A re-rendered fact supersedes the entry it replaces: same keys, old answer, retired.
  for (const entry of inserted) {
    await db
      .update(knowledgeEntries)
      .set({ status: "retired", retired_at: new Date().toISOString() })
      .where(
        and(
          eq(knowledgeEntries.profile_id, proposal.profile_id),
          eq(knowledgeEntries.status, "public"),
          eq(knowledgeEntries.question, entry.question),
          sql_ne(knowledgeEntries.id, entry.id),
        ),
      );
  }
  await recordExecution({ proposalId: proposal.id, result: { published: inserted.length } });
  return inserted;
}

// drizzle's ne, imported under a name that says what it is for.
import { ne as sql_ne } from "drizzle-orm";

export async function retireKnowledgeEntry(
  profileId: string,
  entryId: string,
): Promise<KnowledgeEntryRow> {
  const [row] = await db
    .update(knowledgeEntries)
    .set({ status: "retired", retired_at: new Date().toISOString() })
    .where(
      and(
        eq(knowledgeEntries.id, entryId),
        eq(knowledgeEntries.profile_id, profileId),
        eq(knowledgeEntries.status, "public"),
      ),
    )
    .returning();
  if (!row) throw new KnowledgeError("no such public entry", 404);
  return row;
}

/** Every entry, public first then retired, for the owner's screen. */
export async function listKnowledge(profileId: string): Promise<KnowledgeEntryRow[]> {
  const rows = await db
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.profile_id, profileId))
    .orderBy(knowledgeEntries.published_at);
  return [
    ...rows.filter((r) => r.status === "public"),
    ...rows.filter((r) => r.status !== "public"),
  ];
}

/** Knowledge proposals the owner has approved but not yet published. */
export async function publishableKnowledgeProposals(profileId: string): Promise<ProposalRow[]> {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, KNOWLEDGE_MODULE),
        eq(proposals.status, "approved"),
      ),
    );
  return rows.filter((p) => (p.action as { kind?: string }).kind === KNOWLEDGE_KIND);
}
