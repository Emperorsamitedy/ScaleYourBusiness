// The campaign simulator API — feature 36.
//
//   GET  /api/simulate                       the raw figures the simulator works from, and
//                                            the options the owner can pick; the arithmetic
//                                            itself runs in lib/simulate/model.ts, on either side
//   POST /api/simulate {action:"propose", option}
//                                            the option, recomputed here from fresh figures,
//                                            becomes the normal proposal for its kind — pending,
//                                            or born blocked — with the simulated scenario on it.
//                                            Nothing executes (rule 12).
//
// Reading needs the intake cookie; proposing needs the signed-in owner,
// because a proposal lands in their queue under their name.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import { ProposalError } from "../../../lib/proposals/service";
import { SegmentProposalError } from "../../../lib/crm/segment-proposals";
import { gatherInputs } from "../../../lib/simulate/inputs";
import { SimulateError, catalogOf, parseOption } from "../../../lib/simulate/model";
import { proposeFromSimulation } from "../../../lib/simulate/propose";
import { requireRole } from "../../../lib/auth/roles";

function onError(event: string, error: unknown): NextResponse {
  if (
    error instanceof SimulateError ||
    error instanceof ProposalError ||
    error instanceof SegmentProposalError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event, ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const inputs = await gatherInputs(access.profile_id);
    return NextResponse.json({ inputs, catalog: catalogOf(inputs) });
  } catch (error) {
    return onError("simulate_read_failed", error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json({ error: "proposing needs you signed in" }, { status: 401 });
  }
  const denied = requireRole(access, "proposals.generate");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; option?: unknown };
    if (body.action !== "propose") {
      return NextResponse.json({ error: 'action must be "propose"' }, { status: 422 });
    }
    const option = parseOption(body.option);
    if (!option)
      return NextResponse.json({ error: "that isn't an option I know" }, { status: 422 });
    const outcome = await proposeFromSimulation(access.profile_id, option);
    console.log(
      JSON.stringify({
        event: "simulate_propose",
        profile_id: access.profile_id,
        account_id: access.account_id,
        option: outcome.result.key,
        proposal_id: outcome.proposal?.id ?? null,
        status: outcome.proposal?.status ?? null,
        skipped: outcome.skipped,
      }),
    );
    return NextResponse.json(
      {
        proposal: outcome.proposal,
        skipped: outcome.skipped,
      },
      { status: outcome.proposal ? 201 : 200 },
    );
  } catch (error) {
    return onError("simulate_propose_failed", error);
  }
}
