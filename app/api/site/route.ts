// The site-changes API — Phase 3 Session F.
//
//   GET  /api/site                       site proposals + their executions
//   POST /api/site {url, find, replace}  propose (previews, applies nothing)
//   POST /api/site {action:"apply"}      apply an approved change (signed in)
//   POST /api/site {action:"undo"}       one-click undo, permanent (signed in)

import { desc, eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles, executions, proposals } from "../../../db/schema";
import { currentSession } from "../../../lib/auth/service";
import { ExecutionRefused, undoExecution } from "../../../lib/execution/engine";
import { fixtureSiteExecutor } from "../../../lib/execution/providers/fixture-site";
import { applySiteChange } from "../../../lib/site/apply";
import { SiteChangeError, proposeSiteChange } from "../../../lib/site/changes";
import { SiteFetchError } from "../../../lib/site/fetch";
import { ProposalError } from "../../../lib/proposals/service";

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
    error instanceof SiteChangeError ||
    error instanceof SiteFetchError ||
    error instanceof ProposalError ||
    error instanceof ExecutionRefused
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "site_error", message: String(error) }));
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
  return NextResponse.json({
    proposals: siteRows.map((r) => ({
      ...r,
      execution: execs.find((e) => e.proposal_id === r.id) ?? null,
    })),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      action?: unknown;
      url?: unknown;
      find?: unknown;
      replace?: unknown;
      proposal_id?: unknown;
      execution_id?: unknown;
    };

    if (body.action === "apply" || body.action === "undo") {
      const store = await cookies();
      const session = await currentSession(store.get(AUTH_COOKIE)?.value);
      if (!session) {
        return NextResponse.json(
          { error: "changing a live site needs you signed in" },
          { status: 401 },
        );
      }
      if (body.action === "apply") {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        const outcome = await applySiteChange({ proposalId: body.proposal_id });
        return NextResponse.json({
          status: outcome.execution.status,
          rolled_back: outcome.rolled_back,
          health: outcome.health,
        });
      }
      if (typeof body.execution_id !== "string") {
        return NextResponse.json({ error: "execution_id is required" }, { status: 422 });
      }
      const undone = await undoExecution({
        executionId: body.execution_id,
        provider: fixtureSiteExecutor,
        userId: session.user_id,
      });
      return NextResponse.json({ status: undone.status });
    }

    if (
      typeof body.url !== "string" ||
      typeof body.find !== "string" ||
      typeof body.replace !== "string"
    ) {
      return NextResponse.json({ error: "url, find and replace are required" }, { status: 422 });
    }
    const proposal = await proposeSiteChange(profileId, {
      url: body.url,
      find: body.find,
      replace: body.replace,
    });
    return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
  } catch (error) {
    return onError(error);
  }
}
