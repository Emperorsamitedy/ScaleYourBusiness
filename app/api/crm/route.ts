// The customers API — Phase 4 Sessions A and E (P4-01..04, P4-13/14).
//
//   GET  /api/crm                     contacts (no purchase PII beyond what the owner imported),
//                                     lifecycle counts, segments with their arithmetic, posture
//   POST /api/crm {action:"import", csv, status, statement, currency?}
//   POST /api/crm {action:"erase", contact_id}
//   POST /api/crm {action:"propose_segments"}
//   POST /api/crm {action:"draft_campaign", proposal_id}  an approved campaign → its one email draft
//   POST /api/crm {action:"approve_campaign_email", proposal_id, subject, body_sha256}
//        P4-15: the owner approves the exact email, then the send is tried at once, through the
//        engine; a gate holding it answers in its own words
//   POST /api/crm {action:"send_campaign", proposal_id}  P4-15: try the send again now
//
// Reading needs the intake cookie. Importing, erasing and proposing
// need a signed-in user: an import is an attestation under a name, an
// erasure is irreversible, a proposal lands in the queue.

import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { type NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import type { ConsentStatus } from "../../../lib/crm/contacts";
import {
  ContactError,
  eraseContact,
  listContacts,
  outboundPosture,
} from "../../../lib/crm/contacts";
import {
  campaignCompliance,
  campaignDraftFor,
  draftCampaign,
  POSTAL_ADDRESS_KEY,
} from "../../../lib/crm/campaign-draft";
import { importContacts } from "../../../lib/crm/import";
import {
  CampaignSendError,
  approveCampaignEmail,
  approvedRecipients,
  campaignSendView,
  sendCampaignNow,
} from "../../../lib/crm/campaign-send";
import { BUSINESS_NAME_KEY } from "../../../lib/crm/support-settings";
import { COUNTRY_KEY } from "../../../lib/hours/timezone";
import { readCurrentField } from "../../../lib/profile/field-store";
import {
  SEGMENT_KIND,
  SEGMENT_MODULE,
  SegmentProposalError,
  proposeFromSegments,
} from "../../../lib/crm/segment-proposals";
import { computeSegments, lifecycleOf } from "../../../lib/crm/segments";
import { ProposalError } from "../../../lib/proposals/service";
import { resendEventsWebhookSecret } from "../../../lib/env";
import { activeExecutionConnection } from "../../../lib/execution/connections";
import { emailCampaignOutcome } from "../../../lib/trust/email-readback";

// Review 2026-10-23 (#24): approving a campaign's email tries the send at once,
// and a 50-recipient run paced 600 ms apart takes about 40–60 s. 300 s is
// Vercel's ceiling and stays inside the campaign reclaim's 15 minutes.
export const maxDuration = 300;

const CONSENT: readonly ConsentStatus[] = [
  "explicit_consent",
  "implied_consent",
  "no_consent",
  "unsure",
];

async function resolveProfile(): Promise<{ profile_id: string; account_id: string } | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  return access ? { profile_id: access.profile_id, account_id: access.account_id } : null;
}

function onError(error: unknown): NextResponse {
  if (
    error instanceof ContactError ||
    error instanceof SegmentProposalError ||
    error instanceof ProposalError ||
    error instanceof CampaignSendError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({ event: "crm_error", name: error instanceof Error ? error.name : "unknown" }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const who = await resolveProfile();
  if (!who) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const now = new Date();
    const [contacts, report, posture] = await Promise.all([
      listContacts(who.account_id),
      computeSegments(who.account_id, now),
      outboundPosture(who.profile_id),
    ]);
    return NextResponse.json({
      posture,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        consent_status: c.consent_status,
        lifecycle: lifecycleOf(c, now),
        last_purchase_at: c.last_purchase_at,
        orders_count: c.orders_count,
        total_spent_minor: c.total_spent_minor,
        spent_currency: c.spent_currency,
        country: c.country,
      })),
      lifecycle: report.lifecycle,
      segments: report.segments.map((s) => ({
        key: s.key,
        label: s.label,
        size: s.contact_ids.length,
        emailable: s.emailable_ids.length,
        excluded: s.excluded,
        evidence: s.evidence,
      })),
      campaigns: await campaignsFor(who.profile_id, who.account_id),
      business_name: await answeredText(who.profile_id, BUSINESS_NAME_KEY),
    });
  } catch (error) {
    return onError(error);
  }
}

/**
 * P4-16: approved campaigns, each with its draft (if any) and what the law
 * still wants from it — and, since P4-15, sent ones too, with the send's
 * state: counts by status and reason, unsubscribed since, the gate holding it.
 */
async function campaignsFor(profileId: string, accountId: string) {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, SEGMENT_MODULE),
        inArray(proposals.status, ["approved", "executed"]),
      ),
    );
  const value = async (key: string) => {
    const f = await readCurrentField<string>(profileId, key);
    return f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
      ? f.value.trim()
      : null;
  };
  const [senderName, postalAddress, country] = await Promise.all([
    value(BUSINESS_NAME_KEY),
    value(POSTAL_ADDRESS_KEY),
    value(COUNTRY_KEY),
  ]);
  const compliance = campaignCompliance({ businessCountry: country, senderName, postalAddress });
  const conn = await activeExecutionConnection(accountId, "email_campaign");
  const out = [];
  for (const r of rows) {
    const action = r.action as { kind?: string; summary?: string; detail?: { label?: string } };
    if (action.kind !== SEGMENT_KIND) continue;
    const draft = await campaignDraftFor(r.id);
    out.push({
      proposal_id: r.id,
      summary: action.summary ?? "campaign",
      label: action.detail?.label ?? null,
      approved_at: r.decided_at,
      draft: draft ? { id: draft.id, title: draft.title, body: draft.body } : null,
      gaps: compliance.gaps,
      at_send: compliance.at_send,
      ask: compliance.ask,
      recipients: approvedRecipients(r.action).length,
      irreversible: (r.reversibility as { level?: string } | null)?.level === "hard",
      send: await campaignSendView(r, accountId),
      // P4-17: the readback, once the campaign has gone out.
      readback: r.status === "executed" ? await readbackFor(r, conn?.reply_to ?? null) : null,
    });
  }
  return out;
}

/** P4-17: a sent campaign's readback, with what the screen needs to say what wasn't measured. */
async function readbackFor(proposal: typeof proposals.$inferSelect, repliesTo: string | null) {
  const outcome = await emailCampaignOutcome(proposal);
  const d = outcome.delivery;
  return {
    ...outcome,
    // Reported once the webhook is set up — or when events already came in for this campaign.
    delivery_reported:
      resendEventsWebhookSecret() !== null || d.delivered + d.bounced + d.complained > 0,
    replies_to: repliesTo,
  };
}

async function answeredText(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<string>(profileId, key);
  return f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const who = await resolveProfile();
  if (!who) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json(
      { error: "importing, erasing or proposing needs you signed in" },
      { status: 401 },
    );
  }
  try {
    const body = (await request.json()) as {
      action?: unknown;
      csv?: unknown;
      status?: unknown;
      statement?: unknown;
      currency?: unknown;
      contact_id?: unknown;
      proposal_id?: unknown;
      subject?: unknown;
      body_sha256?: unknown;
    };
    switch (body.action) {
      case "import": {
        if (typeof body.csv !== "string" || typeof body.statement !== "string") {
          return NextResponse.json({ error: "csv and statement are required" }, { status: 422 });
        }
        const status = CONSENT.find((s) => s === body.status);
        if (!status) {
          return NextResponse.json(
            {
              error: "status must be one of explicit_consent, implied_consent, no_consent, unsure",
            },
            { status: 422 },
          );
        }
        const result = await importContacts(
          who.account_id,
          body.csv,
          { status, statement: body.statement },
          typeof body.currency === "string" ? { currency: body.currency } : {},
        );
        const { rows, ...summary } = result;
        return NextResponse.json({ ...summary, rows: rows.length }, { status: 201 });
      }
      case "erase": {
        if (typeof body.contact_id !== "string") {
          return NextResponse.json({ error: "contact_id is required" }, { status: 422 });
        }
        await eraseContact(who.account_id, body.contact_id);
        return NextResponse.json({ erased: true });
      }
      case "propose_segments": {
        const outcome = await proposeFromSegments(who.profile_id);
        return NextResponse.json({
          created: outcome.created.length,
          blocked: outcome.blocked.length,
          skipped: outcome.skipped,
        });
      }
      case "draft_campaign": {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        const { draft, compliance, fresh } = await draftCampaign(body.proposal_id, {
          expectedProfileId: who.profile_id,
        });
        return NextResponse.json(
          { draft_id: draft.id, fresh, gaps: compliance.gaps },
          { status: fresh ? 201 : 200 },
        );
      }
      case "approve_campaign_email": {
        if (
          typeof body.proposal_id !== "string" ||
          typeof body.subject !== "string" ||
          typeof body.body_sha256 !== "string"
        ) {
          return NextResponse.json(
            { error: "proposal_id, subject and body_sha256 are required" },
            { status: 422 },
          );
        }
        await approveCampaignEmail({
          profileId: who.profile_id,
          proposalId: body.proposal_id,
          userId: session.user_id,
          subject: body.subject,
          bodySha256: body.body_sha256,
        });
        const sent = await sendCampaignNow({
          profileId: who.profile_id,
          proposalId: body.proposal_id,
        });
        return NextResponse.json({ approved: true, ...sent });
      }
      case "send_campaign": {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        return NextResponse.json(
          await sendCampaignNow({ profileId: who.profile_id, proposalId: body.proposal_id }),
        );
      }
      default:
        return NextResponse.json(
          {
            error:
              'action must be "import", "erase", "propose_segments", "draft_campaign", "approve_campaign_email" or "send_campaign"',
          },
          { status: 422 },
        );
    }
  } catch (error) {
    return onError(error);
  }
}
