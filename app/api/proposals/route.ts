// The proposals API — Phase 3 Session A (P3-05/07).
//
//   GET  /api/proposals   the swept, grouped queue (+ pending count for badges)
//   POST /api/proposals   generate from the latest report and open interrupts
//   PUT  /api/proposals   decide — approve or decline, one id or a bulk list
//
// Reading needs the intake cookie, like every profile surface. DECIDING
// needs a signed-in user: the schema itself refuses an approval without
// a human id (P3-01), so an unauthenticated decide is a 401 here rather
// than a constraint violation later. Bulk is a loop, deliberately —
// every proposal gets its own conditional-update guard and its own
// decision-log entry; there is no "approve all" shortcut around rule 12.

import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { type NextRequest, NextResponse } from "next/server";
import { generateProposals } from "../../../lib/proposals/generate";
import {
  ProposalError,
  approveProposal,
  proposalQueue,
  rejectProposal,
} from "../../../lib/proposals/service";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

function onError(error: unknown): NextResponse {
  if (error instanceof ProposalError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "proposals_error", message: String(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const queue = await proposalQueue(profileId);
    return NextResponse.json({ ...queue, pending_count: queue.pending.length });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const outcome = await generateProposals(profileId);
    return NextResponse.json({
      created: outcome.created.length,
      blocked: outcome.blocked.length,
      skipped: outcome.skipped,
    });
  } catch (error) {
    return onError(error);
  }
}

interface DecideBody {
  ids?: unknown;
  decision?: unknown;
  reason?: unknown;
  execute_not_before?: unknown;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  const session = await matchingSession();
  if (!session) {
    return NextResponse.json(
      { error: "deciding needs you signed in — approvals carry your name" },
      { status: 401 },
    );
  }

  const body = (await request.json()) as DecideBody;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty list" }, { status: 422 });
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json({ error: 'decision must be "approve" or "reject"' }, { status: 422 });
  }
  if (
    body.decision === "reject" &&
    (typeof body.reason !== "string" || body.reason.trim() === "")
  ) {
    return NextResponse.json(
      { error: "declining asks why — the reason is required" },
      { status: 422 },
    );
  }
  const executeNotBefore =
    typeof body.execute_not_before === "string" &&
    !Number.isNaN(Date.parse(body.execute_not_before))
      ? new Date(body.execute_not_before).toISOString()
      : null;

  const decided: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      if (body.decision === "approve") {
        await approveProposal({
          proposalId: id,
          userId: session.user_id,
          executeNotBefore,
          profileId,
        });
      } else {
        await rejectProposal({
          proposalId: id,
          userId: session.user_id,
          reason: body.reason as string,
          profileId,
        });
      }
      decided.push(id);
    } catch (error) {
      failed.push({
        id,
        error: error instanceof ProposalError ? error.message : "something went wrong",
      });
    }
  }
  return NextResponse.json(
    { decided, failed },
    { status: failed.length > 0 && decided.length === 0 ? 409 : 200 },
  );
}
