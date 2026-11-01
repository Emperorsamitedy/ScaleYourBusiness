// The emergency stop — Phase 3 Session B (P3-12), rule 15's
// owner-visible half.
//
//   GET    /api/stop   is everything halted, since when, by whom
//   POST   /api/stop   HALT — one click, no confirmation, no reason
//                      required. Stopping is the safe direction.
//   DELETE /api/stop   resume — signed in, and the screen confirms
//                      first. Restarting is the risky direction, so
//                      the asymmetry matches P1-44's watch override.
//
// Reading the state needs only the profile: an owner who is halted
// must SEE it everywhere, including in a browser that isn't signed in.
// Halting also accepts an unsigned owner — in an emergency the person
// at the keyboard gets to stop the machine; the row records who when
// a session exists and null when it doesn't, rather than refusing.

import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { type NextRequest, NextResponse } from "next/server";
import { haltExecutions, haltState, resumeExecutions } from "../../../lib/execution/engine";
import { requireRole } from "../../../lib/auth/roles";

async function resolveAccount(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.account_id ?? null;
}

export async function GET(): Promise<NextResponse> {
  const accountId = await resolveAccount();
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  return NextResponse.json(await haltState(accountId));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const accountId = access?.account_id ?? null;
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "stop.press");
  if (denied) return denied;
  const session = await matchingSession();
  let reason: string | undefined;
  try {
    const body = (await request.json()) as { reason?: unknown };
    if (typeof body.reason === "string" && body.reason.trim() !== "") reason = body.reason.trim();
  } catch {
    /* a stop needs no body */
  }
  await haltExecutions({
    accountId,
    userId: session?.user_id ?? null,
    ...(reason ? { reason } : {}),
  });
  console.log(
    JSON.stringify({
      event: "emergency_stop_engaged",
      account_id: accountId,
      by: session?.user_id ?? "unsigned-browser",
    }),
  );
  return NextResponse.json(await haltState(accountId));
}

export async function DELETE(): Promise<NextResponse> {
  const access = await resolveAccess();
  const accountId = access?.account_id ?? null;
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "stop.resume");
  if (denied) return denied;
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json(
      { error: "starting things up again needs you signed in — stopping never does" },
      { status: 401 },
    );
  }
  await resumeExecutions(accountId, session.user_id);
  console.log(
    JSON.stringify({
      event: "emergency_stop_released",
      account_id: accountId,
      by: session.user_id,
    }),
  );
  return NextResponse.json(await haltState(accountId));
}
