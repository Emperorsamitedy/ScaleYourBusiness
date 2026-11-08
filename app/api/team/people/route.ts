// /api/team/people — P6-06, each person's own figures (TASKS-PHASE6.md,
// rule 28 amended; rule 22).
//
//   GET     the per-person figures: { enabled: false } with the team module
//           off (nothing else read), else the figures or why there are none
//   POST    { person, per_week }: state a person's weekly capacity (null clears it)
//   DELETE  { person }: remove a person — their name and figures are erased,
//           their appointments stay in the business's totals
//
// The OWNER ROLE ONLY, for reading as much as changing: a manager or a
// viewer gets the role refusal and never a figure (requireRole with
// "people.read" / "people.manage"). The person's name travels in the JSON
// body, never in the URL. Nothing here is logged with a name.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { requestLocaleOrEnglish } from "../../../../lib/i18n/request-tr";
import {
  PeopleError,
  peopleView,
  readCapacity,
  removePerson,
  stateCapacity,
} from "../../../../lib/people/service";

export const dynamic = "force-dynamic";

function failed(error: unknown, accountId: string): NextResponse {
  if (error instanceof PeopleError) {
    return NextResponse.json({ error: error.reason }, { status: error.status });
  }
  console.error(
    JSON.stringify({ event: "team_people_error", account_id: accountId, ...logSafeError(error) }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

/** The person named in a request body, or null. */
async function personIn(request: NextRequest): Promise<{ person: string; body: unknown } | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const person = (body as { person?: unknown }).person;
  if (typeof person !== "string" || person.trim() === "" || person.length > 200) return null;
  return { person, body };
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "people.read");
  if (denied) return denied;
  try {
    const locale = await requestLocaleOrEnglish();
    return NextResponse.json(await peopleView(access.account_id, new Date(), locale));
  } catch (error) {
    return failed(error, access.account_id);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "people.manage");
  if (denied) return denied;
  const named = await personIn(request);
  if (!named) return NextResponse.json({ error: "name a person" }, { status: 400 });
  const perWeek = readCapacity((named.body as { per_week?: unknown }).per_week);
  if (perWeek === undefined) return NextResponse.json({ error: "bad_capacity" }, { status: 400 });
  try {
    await stateCapacity(access.account_id, access.session?.user_id ?? null, named.person, perWeek);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failed(error, access.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "people.manage");
  if (denied) return denied;
  const named = await personIn(request);
  if (!named) return NextResponse.json({ error: "name a person" }, { status: 400 });
  try {
    const removed = await removePerson(
      access.account_id,
      access.profile_id,
      access.session?.user_id ?? null,
      named.person,
    );
    return NextResponse.json({ ok: true, ...removed });
  } catch (error) {
    return failed(error, access.account_id);
  }
}
