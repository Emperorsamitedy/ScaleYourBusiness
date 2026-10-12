// The OWNER'S support API — Phase 4 Sessions B and D (P4-05..07, P4-12).
//
//   GET  /api/support                         settings, knowledge, tickets, conversations
//   GET  /api/support?conversation=<id>       one transcript
//   POST /api/support {action}                enable | rotate | propose_knowledge |
//                                             propose_custom | publish | retire |
//                                             resolve_ticket | cluster_faq
//
// Reading needs the intake cookie like every profile surface. Every
// mutation needs a signed-in user: publishing puts words in the
// assistant's mouth, rotating a key cuts every embedded widget off, and
// clustering spends a model call.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { currentSession } from "../../../lib/auth/service";
import { FaqError, clusterQuestions } from "../../../lib/crm/faq";
import {
  KnowledgeError,
  listKnowledge,
  proposeCustomKnowledge,
  proposeKnowledgeEntries,
  publishKnowledgeFromProposal,
  publishableKnowledgeProposals,
  retireKnowledgeEntry,
} from "../../../lib/crm/knowledge";
import {
  SupportSettingsError,
  ensureSupportSettings,
  rotateSiteKey,
} from "../../../lib/crm/support-settings";
import { ProposalError } from "../../../lib/proposals/service";
import {
  SupportError,
  listConversations,
  readConversationForOwner,
} from "../../../lib/support/chat";
import { settingsForProfile } from "../../../lib/support/settings";
import { TicketError, listTickets, resolveTicket } from "../../../lib/support/tickets";

const COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";

async function resolveProfile(): Promise<string | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.id ?? null;
}

function onError(error: unknown): NextResponse {
  if (
    error instanceof KnowledgeError ||
    error instanceof SupportSettingsError ||
    error instanceof SupportError ||
    error instanceof TicketError ||
    error instanceof FaqError ||
    error instanceof ProposalError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "support_error", message: String(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

function widgetSnippet(origin: string, siteKey: string): string {
  return `<script src="${origin}/support-widget.js" data-site-key="${siteKey}" async></script>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const conversationId = request.nextUrl.searchParams.get("conversation");
    if (conversationId) {
      return NextResponse.json({
        messages: await readConversationForOwner(profileId, conversationId),
      });
    }
    const [settings, knowledge, publishable, tickets, conversations] = await Promise.all([
      settingsForProfile(profileId),
      listKnowledge(profileId),
      publishableKnowledgeProposals(profileId),
      listTickets(profileId),
      listConversations(profileId),
    ]);
    const origin = process.env.APP_URL?.replace(/\/$/, "") || request.nextUrl.origin;
    return NextResponse.json({
      settings: settings
        ? {
            site_key: settings.site_key,
            business_name: settings.business_name,
            rotated_at: settings.rotated_at,
            snippet: widgetSnippet(origin, settings.site_key),
          }
        : null,
      knowledge,
      publishable: publishable.map((p) => ({
        id: p.id,
        summary: (p.action as { summary?: string }).summary ?? "knowledge proposal",
      })),
      tickets,
      conversations,
    });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  if (!session) {
    return NextResponse.json(
      { error: "changing what the assistant says, or its key, needs you signed in" },
      { status: 401 },
    );
  }
  try {
    const body = (await request.json()) as {
      action?: unknown;
      proposal_id?: unknown;
      entry_id?: unknown;
      ticket_id?: unknown;
      status?: unknown;
      answer?: unknown;
      question?: unknown;
    };
    switch (body.action) {
      case "enable": {
        const settings = await ensureSupportSettings(profileId);
        return NextResponse.json({ site_key: settings.site_key }, { status: 201 });
      }
      case "rotate": {
        const settings = await rotateSiteKey(profileId);
        return NextResponse.json({ site_key: settings.site_key });
      }
      case "propose_knowledge": {
        const proposal = await proposeKnowledgeEntries(profileId);
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      case "propose_custom": {
        if (typeof body.question !== "string" || typeof body.answer !== "string") {
          return NextResponse.json({ error: "question and answer are required" }, { status: 422 });
        }
        const proposal = await proposeCustomKnowledge(profileId, {
          question: body.question,
          answer: body.answer,
        });
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      case "publish": {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        const entries = await publishKnowledgeFromProposal(body.proposal_id, {
          expectedProfileId: profileId,
        });
        return NextResponse.json({ published: entries.length });
      }
      case "retire": {
        if (typeof body.entry_id !== "string") {
          return NextResponse.json({ error: "entry_id is required" }, { status: 422 });
        }
        const entry = await retireKnowledgeEntry(profileId, body.entry_id);
        return NextResponse.json({ status: entry.status });
      }
      case "resolve_ticket": {
        if (typeof body.ticket_id !== "string") {
          return NextResponse.json({ error: "ticket_id is required" }, { status: 422 });
        }
        const status = body.status === "closed" ? "closed" : "answered";
        const ticket = await resolveTicket(
          profileId,
          body.ticket_id,
          status,
          typeof body.answer === "string" ? body.answer : undefined,
        );
        return NextResponse.json({ status: ticket.status, answered: ticket.answer !== null });
      }
      case "cluster_faq": {
        const outcome = await clusterQuestions(profileId, session.account_id);
        return NextResponse.json(outcome);
      }
      default:
        return NextResponse.json(
          {
            error:
              'action must be "enable", "rotate", "propose_knowledge", "propose_custom", "publish", "retire", "resolve_ticket" or "cluster_faq"',
          },
          { status: 422 },
        );
    }
  } catch (error) {
    return onError(error);
  }
}
