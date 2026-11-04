// The site-changes API — Phase 3 Session F.
//
//   GET  /api/site                       site proposals + their executions
//   POST /api/site {url, find, replace}  propose (previews, applies nothing)
//   POST /api/site {action:"apply"}      apply an approved change (signed in)
//   POST /api/site {action:"undo"}       one-click undo, permanent (signed in)

import { logSafeError } from "../../../lib/core/log-safe";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { desc, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { executions, proposals } from "../../../db/schema";
import { ExecutionRefused, undoExecution } from "../../../lib/execution/engine";
import { applySiteChange } from "../../../lib/site/apply";
import { SiteChangeError, proposeSiteChange } from "../../../lib/site/changes";
import { SiteFetchError } from "../../../lib/site/fetch";
import { ProposalError } from "../../../lib/proposals/service";
import { requireRole } from "../../../lib/auth/roles";
import type { RoleAction } from "../../../lib/auth/roles";
import type { AppLocale } from "../../../lib/i18n/locales";
import { requestTr } from "../../../lib/i18n/request-tr";
import type { Tr } from "../../../lib/i18n/tr";
import { localizeSiteProposal, siteErrorWords } from "../../../lib/site/localize";
import { SITE_WORDS } from "../../../lib/site/say";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

function onError(error: unknown, tr: Tr, locale: AppLocale): NextResponse {
  if (
    error instanceof SiteChangeError ||
    error instanceof SiteFetchError ||
    error instanceof ProposalError ||
    error instanceof ExecutionRefused
  ) {
    // L-4c: the site's own refusals in the reader's language; another module's as it said them.
    return NextResponse.json(
      { error: siteErrorWords(error, tr, locale) },
      { status: error.status },
    );
  }
  console.error(JSON.stringify({ event: "site_error", ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const rows = await db
    .select()
    .from(proposals)
    .where(eq(proposals.profile_id, profileId))
    .orderBy(desc(proposals.created_at));
  const siteRows = rows.filter((r) => r.module === "site");
  const execs = siteRows.length
    ? await db
        .select()
        .from(executions)
        .where(
          inArray(
            executions.proposal_id,
            siteRows.map((r) => r.id),
          ),
        )
    : [];
  // L-4c: the stored proposals keep their English; the screen gets the reader's language.
  const { tr, locale } = await requestTr(SITE_WORDS);
  return NextResponse.json({
    proposals: siteRows.map((r) => ({
      ...localizeSiteProposal(r as unknown as Record<string, unknown>, tr, locale),
      execution: execs.find((e) => e.proposal_id === r.id) ?? null,
    })),
  });
}

/** Idea 52: the role each action needs (lib/auth/roles); a body with no action is a proposal. */
const SITE_ROLE: Record<string, RoleAction> = {
  apply: "proposals.carry_out",
  undo: "proposals.carry_out",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const profileId = access?.profile_id ?? null;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { tr, locale } = await requestTr(SITE_WORDS);
  try {
    const body = (await request.json()) as {
      action?: unknown;
      url?: unknown;
      find?: unknown;
      replace?: unknown;
      proposal_id?: unknown;
      execution_id?: unknown;
    };
    const denied = requireRole(access, SITE_ROLE[String(body.action)] ?? "proposals.generate");
    if (denied) return denied;

    if (body.action === "apply" || body.action === "undo") {
      const session = await matchingSession();
      if (!session) {
        return NextResponse.json({ error: tr("error.signedIn") }, { status: 401 });
      }
      if (body.action === "apply") {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: tr("error.proposalId") }, { status: 422 });
        }
        const outcome = await applySiteChange({
          proposalId: body.proposal_id,
          expectedProfileId: profileId,
        });
        return NextResponse.json({
          status: outcome.execution.status,
          rolled_back: outcome.rolled_back,
          health: outcome.health,
        });
      }
      if (typeof body.execution_id !== "string") {
        return NextResponse.json({ error: tr("error.executionId") }, { status: 422 });
      }
      // The provider is resolved from the execution row itself (P3-20a):
      // undo goes through whichever provider did the write.
      const undone = await undoExecution({
        executionId: body.execution_id,
        userId: session.user_id,
        expectedProfileId: profileId,
      });
      return NextResponse.json({ status: undone.status });
    }

    if (
      typeof body.url !== "string" ||
      typeof body.find !== "string" ||
      typeof body.replace !== "string"
    ) {
      return NextResponse.json({ error: tr("error.fields") }, { status: 422 });
    }
    const proposal = await proposeSiteChange(profileId, {
      url: body.url,
      find: body.find,
      replace: body.replace,
    });
    return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
  } catch (error) {
    return onError(error, tr, locale);
  }
}
