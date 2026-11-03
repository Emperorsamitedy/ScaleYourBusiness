// Campaign drafts — P4-16, drafting half (Phase 4 Session F), rules 12, 17, 22, 23.
//
// An approved segment proposal (a win-back, a thank-you) becomes ONE
// email, drafted through Phase 3's voice card with the disclosure on
// (rule 17), and the compliance footer the owner will approve along with
// the words: the business's name and postal address. What can only be
// known at send time — the sending address and each recipient's own
// unsubscribe link — is left as a marked slot the send executor (P4-15)
// fills per recipient, after re-checking consent for every one of them.
//
// What it never does: send, name a recipient, or carry an address
// (rule 22 — the draft holds a count, not a contact). Drafting is not
// executing: the proposal stays approved, because the send is the act
// the approval authorised, and the engine runs it once, in Session F.
//
// The draft also says, before anyone sends, what the law where the
// business is would still want from it (lib/crm/jurisdiction): a missing
// postal address under CAN-SPAM or CASL, or no known regime at all, is
// named on the draft, not discovered at the send.
//
// Idea 47, the cart reminder: the brief names products left in carts, as
// "items from the shop, such as …" (one email reaches every shopper, so it
// never says what any one of them left), and never the person; the model writes no greeting, and the greeting is
// CART_GREETING, put in by code, the same words for every recipient. The
// AI disclosure is added in code after the model, as for every draft.

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, proposals } from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { draftItem } from "../content/draft";
import { disclosureLabel } from "../content/disclosure";
import type { PlannedItem } from "../content/plan";
import { buildVoiceCard } from "../content/voice";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { COUNTRY_KEY } from "../hours/timezone";
import { businessCustomerLocale } from "../i18n/people";
import type { Words } from "../i18n/recipient";
import { englishWords, wordsFor } from "../i18n/recipient";
import { applicableRegimes, messageGaps } from "./jurisdiction";
import { SEGMENT_KIND, SEGMENT_MODULE, SegmentProposalError } from "./segment-proposals";
import { BUSINESS_NAME_KEY } from "./support-settings";

export const POSTAL_ADDRESS_KEY = "legal.postal_address";
export const POSTAL_ADDRESS_QUESTION = "11.1e";
export const BUSINESS_NAME_QUESTION = "1.1";
/**
 * Idea 47: the cart reminder's greeting. Put in by code, never by the model,
 * and the same for every recipient: nothing here knows who they are. This
 * is English's; L-6 writes it in the business's language (`emails.campaign.greeting`).
 */
export const CART_GREETING = "Hello,";
/** The slot the send executor fills per recipient (P4-15). Never a real link in a draft. */
export const UNSUBSCRIBE_SLOT = "{{unsubscribe_url}}";

export type CampaignDraftRow = typeof contentItems.$inferSelect;

export interface CampaignCompliance {
  /** The regimes the business sends under, or why there are none. */
  regimes: string[];
  refused: string | null;
  /** What the draft still lacks, in the owner's words. Empty = ready for the send check. */
  gaps: string[];
  /** Added at send time, never in the draft. */
  at_send: string[];
  /** The bank questions that close the gaps, so the screen can link straight to them. */
  ask: { question_id: string; label: string }[];
}

async function answered(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<string>(profileId, key);
  return f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;
}

/**
 * Pure: the footer every campaign email carries, with the per-recipient
 * slot. L-6: in the business's language (`w`), English by default.
 */
export function complianceFooter(
  senderName: string | null,
  postalAddress: string | null,
  w: Words = englishWords("emails.campaign"),
): string {
  const who = senderName ?? w.t("thisBusiness");
  return [
    "—",
    postalAddress ? `${who} · ${postalAddress}` : who,
    w.t("why", { business: who, link: UNSUBSCRIBE_SLOT }),
  ].join("\n");
}

/** Pure: what the draft still needs under the business's regimes. */
export function campaignCompliance(args: {
  businessCountry: string | null;
  senderName: string | null;
  postalAddress: string | null;
}): CampaignCompliance {
  const lookup = applicableRegimes({ businessCountry: args.businessCountry });
  const at_send = ["the sending address", "each recipient's own unsubscribe link"];
  if (!lookup.ok) {
    return { regimes: [], refused: lookup.reason, gaps: [lookup.reason], at_send, ask: [] };
  }
  const gaps = messageGaps(
    {
      sender_name: args.senderName ?? "",
      sender_email: "",
      postal_address: args.postalAddress,
      unsubscribe_url: null,
      disclosure: disclosureLabel("email"),
    },
    lookup.regimes,
    "draft",
  );
  const ask = [
    ...(gaps.some((g) => g.startsWith("the business's name"))
      ? [{ question_id: BUSINESS_NAME_QUESTION, label: "Add your business name" }]
      : []),
    ...(gaps.some((g) => g.startsWith("the business's postal address"))
      ? [{ question_id: POSTAL_ADDRESS_QUESTION, label: "Add your postal address" }]
      : []),
  ];
  return { regimes: lookup.regimes.map((r) => r.id), refused: null, gaps, at_send, ask };
}

/**
 * The draft for a campaign proposal, if there is one. Ordered, so every
 * reader — the screen that shows the body's sha, the approval, the send —
 * names the same row even if an older double draft exists (review 2026-10-23, #22).
 */
export async function campaignDraftFor(proposalId: string): Promise<CampaignDraftRow | null> {
  const [row] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.proposal_id, proposalId), eq(contentItems.kind, "email")))
    .orderBy(asc(contentItems.created_at), asc(contentItems.id))
    .limit(1);
  return row ?? null;
}

/**
 * Draft the email an approved campaign proposal promised. Idempotent: a
 * proposal that already has its draft returns it with no model call.
 */
export async function draftCampaign(
  proposalId: string,
  opts: { draftLlm?: DraftLlm; limitLlm?: LimitLlm; expectedProfileId?: string; now?: Date } = {},
): Promise<{ draft: CampaignDraftRow; compliance: CampaignCompliance; fresh: boolean }> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  // Ownership clause: a foreign proposal is missing, 404.
  if (!proposal || (opts.expectedProfileId && proposal.profile_id !== opts.expectedProfileId)) {
    throw new SegmentProposalError("no such proposal", 404);
  }
  const action = proposal.action as {
    kind?: string;
    detail?: {
      segment?: string;
      label?: string;
      what?: string;
      contact_ids?: unknown[];
      evidence?: string[];
      products?: unknown[];
    };
  };
  if (proposal.module !== SEGMENT_MODULE || action.kind !== SEGMENT_KIND) {
    throw new SegmentProposalError("this proposal isn't a customer email", 422);
  }
  if (proposal.status !== "approved") {
    throw new SegmentProposalError(
      `only an approved campaign is drafted — this one is ${proposal.status}`,
      409,
    );
  }

  const profileId = proposal.profile_id;
  const [senderName, postalAddress, country] = await Promise.all([
    answered(profileId, BUSINESS_NAME_KEY),
    answered(profileId, POSTAL_ADDRESS_KEY),
    answered(profileId, COUNTRY_KEY),
  ]);
  const compliance = campaignCompliance({ businessCountry: country, senderName, postalAddress });

  const existing = await campaignDraftFor(proposal.id);
  if (existing) return { draft: existing, compliance, fresh: false };

  const [acct] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const detail = action.detail ?? {};
  const label = detail.label ?? "your customers";
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const cart = detail.segment === "abandoned_cart";
  const products = (detail.products ?? []).filter((x): x is string => typeof x === "string");
  const item: PlannedItem = {
    date: today,
    channel_id: "",
    channel_label: "email",
    format: "email",
    goal_id: null,
    focus: label,
    brief: cart
      ? `${detail.what ?? "One email to shoppers who left a cart"} One email for everyone in the group: ` +
        // Review 2026-10-30: the same words reach every shopper, so they can't say
        // what this one left, nor hint at what anyone else did.
        "Each of them left a cart, but not the same things, so speak of items from the shop" +
        `${products.length > 0 ? `, such as ${products.join(", ")}` : ""}; ` +
        "never say or imply the reader left all of these, or what anyone else left. " +
        "Never name or describe the person, and don't say how you know who they are. " +
        "Start straight after the greeting: no greeting line, it is added separately. " +
        "Don't invent offers, prices, discounts, stock levels or deadlines. " +
        "No sign-off block: the footer is added separately."
      : `${detail.what ?? "One email to this group of customers"}. One email for everyone in the group — ` +
        "no names, no personal details, no greeting by name. Don't invent offers, prices or discounts. " +
        "No sign-off block: the footer is added separately.",
    evidence: detail.evidence ?? [],
  };
  const card = await buildVoiceCard(profileId, opts.limitLlm);
  const draft = await draftItem({
    card,
    item,
    kind: "email",
    accountId: acct?.account_id ?? profileId,
    ...(opts.draftLlm ? { llm: opts.draftLlm } : {}),
  });

  // L-6: the greeting and footer code adds are in the business's language (its customers read it).
  const words = await wordsFor(await businessCustomerLocale(profileId), "emails.campaign");

  // The insert is conditional (review 2026-10-23, #22): under a lock per
  // proposal, a draft that appeared while this one was being written wins,
  // so a double-click stores ONE email and both clicks are shown the same.
  const stored = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`campaign-draft:${proposal.id}`}))`,
    );
    const [already] = await tx
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.proposal_id, proposal.id), eq(contentItems.kind, "email")))
      .orderBy(asc(contentItems.created_at), asc(contentItems.id))
      .limit(1);
    if (already) return { row: already, fresh: false };
    const [inserted] = await tx
      .insert(contentItems)
      .values({
        profile_id: profileId,
        proposal_id: proposal.id,
        kind: "email",
        channel_label: `email · ${label}`,
        scheduled_for: null,
        title: `${label} — campaign email`,
        body: `${cart ? `${words.t("greeting")}\n\n` : ""}${draft.body}\n\n${complianceFooter(senderName, postalAddress, words)}`,
        disclosure: disclosureLabel("email"),
        provenance: {
          ...draft.provenance,
          evidence: item.evidence,
          // A count, never a contact (rule 22): who receives it is decided again at send time.
          campaign: {
            segment: detail.segment ?? null,
            recipients_at_proposal: detail.contact_ids?.length ?? 0,
          },
          compliance,
        },
      })
      .returning();
    return { row: inserted, fresh: true };
  });
  if (!stored.row) throw new SegmentProposalError("the draft could not be stored", 500);
  return { draft: stored.row, compliance, fresh: stored.fresh };
}
