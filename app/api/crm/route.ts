// The customers API — Phase 4 Sessions A and E (P4-01..04, P4-13/14).
//
//   GET  /api/crm                     contacts (no purchase PII beyond what the owner imported),
//                                     lifecycle counts, segments with their arithmetic, posture
//   POST /api/crm {action:"import", csv, status, statement, currency?}
//   POST /api/crm {action:"erase", contact_id}
//   POST /api/crm {action:"propose_segments"}
//   POST /api/crm {action:"draft_campaign", proposal_id}  an approved campaign → its one email draft
//
// Reading needs the intake cookie. Importing, erasing and proposing
// need a signed-in user: an import is an attestation under a name, an
// erasure is irreversible, a proposal lands in the queue.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { businessProfiles, proposals } from "../../../db/schema";
import { currentSession } from "../../../lib/auth/service";
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

const COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";
const CONSENT: readonly ConsentStatus[] = [
  "explicit_consent",
  "implied_consent",
  "no_consent",
  "unsure",
];

async function resolveProfile(): Promise<{ profile_id: string; account_id: string } | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row ? { profile_id: row.id, account_id: row.account_id } : null;
}

function onError(error: unknown): NextResponse {
  if (
    error instanceof ContactError ||
    error instanceof SegmentProposalError ||
    error instanceof ProposalError
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
      campaigns: await campaignsFor(who.profile_id),
    });
  } catch (error) {
    return onError(error);
  }
}

/** P4-16: approved campaigns, each with its draft (if any) and what the law still wants from it. */
async function campaignsFor(profileId: string) {
  const rows = await db
    .select({ id: proposals.id, action: proposals.action, decided_at: proposals.decided_at })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, SEGMENT_MODULE),
        eq(proposals.status, "approved"),
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
    });
  }
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const who = await resolveProfile();
  if (!who) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
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
      default:
        return NextResponse.json(
          { error: 'action must be "import", "erase", "propose_segments" or "draft_campaign"' },
          { status: 422 },
        );
    }
  } catch (error) {
    return onError(error);
  }
}
