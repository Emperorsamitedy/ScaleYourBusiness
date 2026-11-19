// Follow-ups — Phase 5 Session D (P5-16), rules 12, 15, 17, 23, 24, 29.
//
// A quiet deal becomes a PROPOSAL: "Follow up a quiet deal: proposal sent,
// 23 days without a word". Through every Phase 3 gate, like the segment
// campaigns (lib/crm/segment-proposals): nothing is proposed while the
// business is being watched (rule 15), the owner's hard limits are checked
// (rule 14), three declines silence the kind (P3-28), and the owner's own
// 6.4b "no consent" switches it off wholesale.
//
// Consent (rule 23): a follow-up email is proposed only to a contact the
// consent gate lets SYB email for marketing — explicit consent, an address,
// no suppression — checked per contact when proposing and again when
// drafting. A sales follow-up is treated as outbound, conservatively: the
// screen tells the owner to call anyone else, or to record their consent.
//
// Sending (P5-16b; rule 29 amended by the owner on 2026-11-16: "make all
// these automatic all the owner should do is just approve"). Approving the
// proposal lets SYB draft; approving the exact email (lib/pipeline/
// followup-send approveFollowUpEmail) lets SYB send it. The due runner routes
// it to the followup_email provider, which checks the contact's consent
// again at the moment of sending and stays held until real sending is on.
// A sent email can't be recalled, so new proposals are labelled "hard".
//
// Drafting (rule 24's minimum): Sonnet through Phase 3's drafting fence
// (lib/content/draft: the voice card, no invented facts, disclosure applied
// by code). The brief names NO ONE: no contact name, address, phone,
// company, deal name or next-step text — only the stage and how long it has
// been quiet. The greeting is a {{name}} slot the screen fills from the
// contact. Caps are checked before any call: one draft per proposal, 30 a
// month per account, and €2 a month of the "pipeline_followup" workload.
//
// The proposal and the draft carry ids, never a contact's details (rule 22);
// the draft goes with the deal when the contact is erased (db cascade).

import { createHash } from "node:crypto";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  campaignSends,
  contacts,
  dealFollowups,
  deals,
  executions,
  llmCalls,
  proposals,
} from "../../db/schema";
import { followUpSendingMode } from "../execution/providers/followup-email";
import { careState } from "../care/day-zero";
import type { DraftLlm } from "../content/draft";
import { draftItem, draftLlmFor } from "../content/draft";
import { disclosureLabel } from "../content/disclosure";
import type { PlannedItem } from "../content/plan";
import { buildVoiceCard } from "../content/voice";
import type { Money } from "../core/money";
import { canEmailForMarketing, outboundPosture } from "../crm/contacts";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import { DealError, dealFacts, dealValue, listDeals, pipelineApplies } from "./deals";
import type { DealAge, PipelineSentenceWords, Staleness } from "./maths";
import { dealAge, englishPipelineWords, staleDeals, staleness } from "./maths";
import type { DealStage } from "./stages";
import { STAGE_LABELS, isOpenStage } from "./stages";
import { watchingUntil } from "../care/watch-words";
import { businessLanguage } from "../llm/language-of";

export const PIPELINE_MODULE = "pipeline";
export const FOLLOWUP_KIND = "deal_followup";
/** The greeting slot the screen fills from the contact; the model never sees a name. */
export const NAME_SLOT = "{{name}}";

export const FOLLOWUP = {
  /** New follow-up proposals per run, longest-quiet first. */
  max_per_run: 5,
  expiry_days: 14,
  /** Drafts per account per calendar month (UTC). */
  drafts_per_month: 30,
  /** Spend on the follow-up workload per account per month, in euros. */
  monthly_cap_eur: 2,
  workload: "pipeline_followup",
} as const;

export interface FollowUpOutcome {
  created: ProposalRow[];
  blocked: ProposalRow[];
  skipped: { deal_id: string | null; reason: string }[];
}

function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** "proposal sent, 23 days since you last spoke" — no names. */
export function quietWords(stage: DealStage, age: DealAge): string {
  const days = `${age.days_quiet} day${age.days_quiet === 1 ? "" : "s"}`;
  return `${STAGE_LABELS[stage].toLowerCase()}, ${days} ${
    age.quiet_from === "last_contact"
      ? "since you last spoke"
      : "since you added it, with no word recorded"
  }`;
}

export function staleWords(stale: Staleness): string {
  return stale.why === "no_next_step"
    ? "no next step is set"
    : `the next step was due ${stale.due} (${stale.days_over} day${stale.days_over === 1 ? "" : "s"} ago)`;
}

/** The bank questions the hold sentences name (6.1a who they sell to, 6.4b customer consent). */
export const B2B_QUESTION = "6.1a";
export const CONSENT_QUESTION = "6.4b";

/** Pure: the summary on the queue card. It names no one (rule 22). */
export function followUpSummary(stage: DealStage, age: DealAge): string {
  return `Follow up a quiet deal: ${quietWords(stage, age)}`;
}

/**
 * Why no follow-up can be proposed right now, or null when they can: not a
 * business that sells to businesses, the watch (rule 15), or the owner's
 * 6.4b "no consent". Read-only — the screen asks the same question.
 */
export async function followUpHold(
  profileId: string,
  now: Date = new Date(),
  words: PipelineSentenceWords = englishPipelineWords(),
): Promise<string | null> {
  // L-4b: in the screen's words; in English exactly NOT_B2B and the 6.4b line as before.
  if (!(await pipelineApplies(profileId))) {
    return words.tr("hold.notB2b", { question: B2B_QUESTION });
  }
  const care = await careState(profileId);
  if (care?.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return watchingUntil(care.watch_ends_at);
  }
  if ((await outboundPosture(profileId)) === "disabled") {
    return words.tr("hold.noConsent", { question: CONSENT_QUESTION });
  }
  return null;
}

/**
 * Propose a follow-up for each stale open deal whose contact may be emailed,
 * at most once per deal per month. Honest about every skip.
 */
export async function proposeFollowUps(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm; words?: PipelineSentenceWords } = {},
): Promise<FollowUpOutcome> {
  // L-4b: the skip reasons go back to the screen in its words; the proposal
  // itself (summary, assumptions) is stored in English, whatever they are.
  const { tr } = opts.words ?? englishPipelineWords();
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const out: FollowUpOutcome = { created: [], blocked: [], skipped: [] };

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new DealError("no such profile", 404);

  const hold = await followUpHold(profileId, now, opts.words);
  if (hold !== null) {
    out.skipped.push({ deal_id: null, reason: hold });
    return out;
  }

  const rows = await listDeals(profileId);
  const stale = staleDeals(
    rows.map((r) => dealFacts(r.deal)),
    today,
  );
  if (stale.length === 0) {
    out.skipped.push({ deal_id: null, reason: tr("skip.noneQuiet") });
    return out;
  }
  const { limits } = await ensureHardLimits(profileId, opts.limitLlm);
  const suppression = (await suppressedKinds(profileId)).get(FOLLOWUP_KIND);
  const existing = await db
    .select({ ref: proposals.originating_finding })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, PIPELINE_MODULE)));
  const seen = new Set(existing.map((r) => r.ref));

  for (const s of stale) {
    if (out.created.length + out.blocked.length >= FOLLOWUP.max_per_run) {
      out.skipped.push({
        deal_id: s.deal.id,
        reason: tr("skip.perRun", { max: FOLLOWUP.max_per_run }),
      });
      continue;
    }
    const ref = `pipeline:followup:${s.deal.id}:${monthKey(now)}`;
    if (seen.has(ref)) {
      out.skipped.push({ deal_id: s.deal.id, reason: tr("skip.already") });
      continue;
    }
    const row = rows.find((r) => r.deal.id === s.deal.id)!;
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, row.contact.id));
    const permission = contact
      ? await canEmailForMarketing(contact)
      : { allowed: false, reason: tr("skip.contactGone") };
    if (!permission.allowed) {
      out.skipped.push({
        deal_id: s.deal.id,
        // permission.reason is lib/crm's own English (L-4b: not this area's words).
        reason: tr("skip.cantEmail", { why: permission.reason }),
      });
      continue;
    }
    if (suppression) {
      out.skipped.push({
        deal_id: s.deal.id,
        reason: tr("skip.declined", { count: suppression.rejections }),
      });
      continue;
    }
    const verdict = checkHardLimits(limits, FOLLOWUP_KIND);
    const value: Money | null = dealValue(row.deal);
    const created = await createProposal({
      profile_id: profileId,
      module: PIPELINE_MODULE,
      originating_finding: ref,
      action: {
        kind: FOLLOWUP_KIND,
        summary: followUpSummary(s.deal.stage, s.age),
        detail: {
          deal_id: s.deal.id,
          contact_id: row.contact.id,
          stage: s.deal.stage,
          days_quiet: s.age.days_quiet,
          quiet_from: s.age.quiet_from,
          days_in_stage: s.age.days_in_stage,
          stale: s.stale,
          value,
          what: "One short email in your voice, checking in on a deal that has gone quiet.",
          sending:
            "Approving lets me draft the email. You read it and approve the exact email, and then I send it from ScaleX's email service under your business's name, with replies going to you. Their consent is checked again at the moment it goes.",
          manual_limits: verdict.manual.map((l) => l.quote),
        },
      },
      scenario: {
        assumptions: [
          {
            statement: `the deal has gone quiet: ${quietWords(s.deal.stage, s.age)}, and ${staleWords(s.stale)}`,
            value: null,
            source_field: null,
            sensitivity: "low",
          },
          {
            statement:
              "the contact holds explicit consent and no suppression, decided when proposing and again when drafting",
            value: null,
            source_field: null,
            sensitivity: "low",
          },
        ],
        base_case: {
          case: "base",
          statement: "A short, friendly check-in gets a reply or a clear no.",
          profit_delta_monthly: null,
          formula: null,
        },
        downside_case: {
          case: "downside",
          statement: "No answer; the deal stays where it is, and you decide whether to call.",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: {
          case: "upside",
          statement: "The deal moves again.",
          profit_delta_monthly: null,
          formula: null,
        },
        breakeven_condition: "not computed: a follow-up costs nothing but a minute of your reading",
      } as ScenarioBlock,
      reversibility: {
        level: "hard",
        if_you_change_your_mind:
          "A sent email can't be recalled. Until you approve the exact email nothing goes out: decline it, or don't approve the draft, and no one hears anything.",
      },
      expires_at: new Date(now.getTime() + FOLLOWUP.expiry_days * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    });
    (verdict.verdict === "blocked" ? out.blocked : out.created).push(created);
  }
  console.log(
    JSON.stringify({
      event: "followup_proposals",
      profile_id: profileId,
      account_id: profile.account_id,
      created: out.created.length,
      blocked: out.blocked.length,
      skipped: out.skipped.length,
    }),
  );
  return out;
}

/* ── drafting ── */

export interface FollowUpBriefFacts {
  stage: DealStage;
  age: DealAge;
  stale: Staleness | null;
}

/**
 * Pure: the brief the model gets. It names no one and carries no deal
 * words — only the stage and the time — so nothing personal reaches the
 * prompt (rule 24's minimum).
 */
export function followUpBrief(f: FollowUpBriefFacts): string {
  const where =
    f.stage === "proposal_sent"
      ? "We sent them a proposal"
      : f.stage === "qualified"
        ? "We talked through what they need"
        : "They showed interest";
  return [
    `${where}, and it has been ${f.age.days_quiet} day${f.age.days_quiet === 1 ? "" : "s"} ${
      f.age.quiet_from === "last_contact" ? "since we last spoke" : "with no word"
    }.`,
    "Write a short, friendly follow-up to a business customer: check in, offer to answer questions, suggest a next step without pressure.",
    `Begin with exactly "Hi ${NAME_SLOT}," — that slot is filled in later; never write a name.`,
    "Don't mention prices, dates, discounts, deadlines or anything the brief doesn't say. No subject line, no sign-off block.",
  ].join(" ");
}

export class FollowUpError extends DealError {}

function monthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

/** Spend on the follow-up workload this month, in euros. */
async function monthlySpendEur(accountId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${llmCalls.cost_eur}), 0)::text` })
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.account_id, accountId),
        eq(llmCalls.workload, FOLLOWUP.workload),
        gte(llmCalls.at, monthStart(now)),
      ),
    );
  return Number.parseFloat(row?.total ?? "0");
}

export type FollowUpDraftRow = typeof dealFollowups.$inferSelect;

/**
 * Draft the email an approved follow-up promised. Idempotent: a proposal
 * that has its draft returns it with no model call. Refused, before any
 * call, when the deal is gone or closed, consent no longer holds, or a cap
 * is reached.
 */
export async function draftFollowUp(
  proposalId: string,
  opts: { draftLlm?: DraftLlm; limitLlm?: LimitLlm; expectedProfileId?: string; now?: Date } = {},
): Promise<{ draft: FollowUpDraftRow; fresh: boolean }> {
  const now = opts.now ?? new Date();
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal || (opts.expectedProfileId && proposal.profile_id !== opts.expectedProfileId)) {
    throw new FollowUpError("no such proposal", 404);
  }
  const action = proposal.action as { kind?: string; detail?: { deal_id?: unknown } };
  if (proposal.module !== PIPELINE_MODULE || action.kind !== FOLLOWUP_KIND) {
    throw new FollowUpError("this proposal isn't a deal follow-up", 422);
  }
  if (proposal.status !== "approved") {
    throw new FollowUpError(
      `only an approved follow-up is drafted: this one is ${proposal.status}`,
      409,
    );
  }
  const [existing] = await db
    .select()
    .from(dealFollowups)
    .where(eq(dealFollowups.proposal_id, proposal.id));
  if (existing) return { draft: existing, fresh: false };

  const dealId = typeof action.detail?.deal_id === "string" ? action.detail.deal_id : null;
  const [deal] = dealId
    ? await db
        .select()
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.profile_id, proposal.profile_id)))
    : [];
  if (!deal) throw new FollowUpError("that deal is gone: it went with its contact", 410);
  if (!isOpenStage(deal.stage)) {
    throw new FollowUpError(
      `that deal is ${STAGE_LABELS[deal.stage].toLowerCase()} now: no follow-up needed`,
      409,
    );
  }
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, deal.contact_id));
  const permission = contact
    ? await canEmailForMarketing(contact)
    : { allowed: false, reason: "the contact is gone" };
  if (!permission.allowed) {
    throw new FollowUpError(`I can't draft an email to them now: ${permission.reason}`, 409);
  }
  if ((await outboundPosture(proposal.profile_id)) === "disabled") {
    throw new FollowUpError('your 6.4b answer is "no consent": outbound email is off', 409);
  }

  // The caps, before any call.
  const [drafted] = await db
    .select({ n: count() })
    .from(dealFollowups)
    .where(
      and(
        eq(dealFollowups.account_id, deal.account_id),
        gte(dealFollowups.created_at, monthStart(now)),
      ),
    );
  if (Number(drafted?.n ?? 0) >= FOLLOWUP.drafts_per_month) {
    throw new FollowUpError(
      `I've drafted ${FOLLOWUP.drafts_per_month} follow-ups this month, my limit: write this one yourself`,
      429,
    );
  }
  if ((await monthlySpendEur(deal.account_id, now)) >= FOLLOWUP.monthly_cap_eur) {
    throw new FollowUpError(
      `this month's drafting budget for follow-ups (€${FOLLOWUP.monthly_cap_eur}) is used: write this one yourself`,
      429,
    );
  }

  const facts = dealFacts(deal);
  const today = now.toISOString().slice(0, 10);
  const brief = followUpBrief({
    stage: deal.stage,
    age: dealAge(facts, today),
    stale: staleness(facts, today),
  });
  const item: PlannedItem = {
    date: today,
    channel_id: "",
    channel_label: "email",
    format: "email",
    goal_id: null,
    focus: "a quiet deal",
    brief,
    evidence: [],
  };
  const card = await buildVoiceCard(proposal.profile_id, opts.limitLlm);
  const draft = await draftItem({
    card,
    item,
    kind: "email",
    accountId: deal.account_id,
    // L-5: the follow-up is read by the contact — the business's language.
    language: await businessLanguage(proposal.profile_id),
    llm: opts.draftLlm ?? draftLlmFor(FOLLOWUP.workload),
  });

  const [inserted] = await db
    .insert(dealFollowups)
    .values({
      account_id: deal.account_id,
      profile_id: proposal.profile_id,
      deal_id: deal.id,
      proposal_id: proposal.id,
      body: draft.body,
      disclosure: disclosureLabel("email"),
      provenance: draft.provenance,
    })
    .onConflictDoNothing({ target: dealFollowups.proposal_id })
    .returning();
  if (inserted) {
    console.log(
      JSON.stringify({
        event: "followup_drafted",
        account_id: deal.account_id,
        deal_id: deal.id,
        proposal_id: proposal.id,
      }),
    );
    return { draft: inserted, fresh: true };
  }
  // A double click: the other draft won the insert; both are shown the same one.
  const [winner] = await db
    .select()
    .from(dealFollowups)
    .where(eq(dealFollowups.proposal_id, proposal.id));
  if (!winner) throw new FollowUpError("the draft could not be stored", 500);
  return { draft: winner, fresh: false };
}

/** Pure: the draft as the owner reads it, the slot filled from the contact's first name. */
export function fillName(body: string, name: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return body.split(NAME_SLOT).join(first === "" ? "there" : first);
}

/**
 * P5-16b: where a follow-up's send stands, for the screen.
 *   ready      the exact email is approved; it goes out on the next run
 *   waiting    approved, but real sending is switched off: held until it is
 *   sent       it went
 *   unconfirmed the email service never confirmed it; never sent again
 *   not_sent   refused at the moment of sending (consent, the service), or failed
 */
export type FollowUpSendState = "ready" | "waiting" | "sent" | "unconfirmed" | "not_sent";

export interface FollowUpState {
  proposal_id: string;
  deal_id: string | null;
  status: ProposalRow["status"];
  summary: string;
  blocked_by_limit: string | null;
  draft: { body: string; disclosure: string } | null;
  /** sha256 of the draft body as it is now — what an approval must name. */
  body_sha256: string | null;
  /** The subject the owner approved the email under, once they have. */
  approved_subject: string | null;
  /** True when the approval names the draft as it is now. */
  email_approved: boolean;
  /** False for follow-ups proposed before 2026-11-16, labelled undoable: they can't be sent. */
  sendable: boolean;
  send: FollowUpSendState | null;
  sent_at: string | null;
  /** The engine's last sentence for this follow-up, when a run ended without sending. */
  error: string | null;
}

/** Pure: the send state from the approval, the send row and whether real sending is on. */
export function sendStateOf(args: {
  email_approved: boolean;
  row: { status: string } | null;
  error: string | null;
  real: boolean;
}): FollowUpSendState | null {
  const status = args.row?.status;
  if (status === "sent") return "sent";
  if (status === "sending" || status === "unknown") return "unconfirmed";
  if (status === "refused" || status === "failed") return "not_sent";
  if (args.error !== null) return "not_sent";
  if (!args.email_approved) return null;
  return args.real ? "ready" : "waiting";
}

/** Every follow-up proposal of the profile, newest first, with its draft and its send. */
export async function followUpsFor(profileId: string): Promise<FollowUpState[]> {
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, PIPELINE_MODULE)))
    .orderBy(sql`${proposals.created_at} desc`);
  const drafts = await db
    .select()
    .from(dealFollowups)
    .where(eq(dealFollowups.profile_id, profileId));
  const followUps = rows.filter((r) => (r.action as { kind?: string }).kind === FOLLOWUP_KIND);
  const ids = followUps.map((r) => r.id);
  const sends = ids.length
    ? await db
        .select({
          proposal_id: campaignSends.proposal_id,
          status: campaignSends.status,
          sent_at: campaignSends.sent_at,
        })
        .from(campaignSends)
        .where(inArray(campaignSends.proposal_id, ids))
    : [];
  const runs = ids.length
    ? await db
        .select({
          proposal_id: executions.proposal_id,
          status: executions.status,
          error: executions.error,
          held_for: executions.held_for,
        })
        .from(executions)
        .where(inArray(executions.proposal_id, ids))
    : [];
  const real = followUpSendingMode(process.env).mode === "real";
  return followUps.map((r) => {
    const action = r.action as { summary?: string; detail?: { deal_id?: unknown } };
    const d = drafts.find((x) => x.proposal_id === r.id);
    const bodySha = d ? createHash("sha256").update(d.body).digest("hex") : null;
    const emailApproved =
      d !== undefined && d.approved_sha256 === bodySha && d.approved_at !== null;
    const row = sends.find((s) => s.proposal_id === r.id) ?? null;
    const run = runs.find((x) => x.proposal_id === r.id);
    // A held run (the stop, the service asking to slow down) resumes on its own: not an error.
    const error =
      run && run.status === "failed" && run.held_for === null && !row ? (run.error ?? null) : null;
    return {
      proposal_id: r.id,
      deal_id: typeof action.detail?.deal_id === "string" ? action.detail.deal_id : null,
      status: r.status,
      summary: action.summary ?? "Follow up a quiet deal",
      blocked_by_limit: r.blocked_by_limit,
      draft: d ? { body: d.body, disclosure: d.disclosure } : null,
      body_sha256: bodySha,
      approved_subject: emailApproved ? (d?.approved_subject ?? null) : null,
      email_approved: emailApproved,
      sendable: (r.reversibility as { level?: string } | null)?.level === "hard",
      send: sendStateOf({ email_approved: emailApproved, row, error, real }),
      sent_at: row?.sent_at ?? null,
      error,
    };
  });
}
