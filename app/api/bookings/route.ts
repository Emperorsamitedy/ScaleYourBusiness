// The bookings API — specs/bookings.md §3–5.
//
//   GET   /api/bookings   what has been imported, and the 28-day measures per source
//   POST  /api/bookings   { csv, platform, currency?, date_order?, decimal_style? }: import one export
//
// Importing measurement into an account is an account-level act, like
// connecting a source, so both need a signed-in session. Nothing here logs
// a request body: an export carries client names and emails, which are
// read once, hashed or dropped, and never stored or echoed back.
//
// L-4c: a refusal of the import and the measures' sentences are said in the
// reader's language (requestTr over "connectionsWords"); English is exactly
// what this route always sent. The sign-in refusal is L-4a's.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { AuthedSession } from "../../../lib/auth/service";
import { currentSession } from "../../../lib/auth/service";
import {
  BOOKINGS_MAP,
  BOOKING_PLATFORMS,
  isBookingPlatform,
} from "../../../lib/bookings/import-map";
import { BookingImportError } from "../../../lib/bookings/rows";
import { isDecimalStyle } from "../../../lib/core/money";
import { bookingsView, importBookings } from "../../../lib/bookings/store";
import { requireRole } from "../../../lib/auth/roles";
import { requestTr } from "../../../lib/i18n/request-tr";
import type { Say } from "../../../lib/bookings/words";
import { CONNECTIONS_WORDS, sayRefusal } from "../../../lib/bookings/words";

const AUTH_COOKIE = "syb_session";

async function signedIn(): Promise<AuthedSession | null> {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

/** The request's language for this route's sentences. */
const words = (): Promise<Say> => requestTr(CONNECTIONS_WORDS);

function onError(error: unknown, accountId: string, say: Say): NextResponse {
  if (error instanceof BookingImportError) {
    return NextResponse.json({ error: sayRefusal(error.words, say) }, { status: error.status });
  }
  // The error's name only: a message could quote a cell of the file.
  console.error(
    JSON.stringify({
      event: "bookings_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return NextResponse.json({ error: say.tr("bookings.refuse.ourSide") }, { status: 500 });
}

const platforms = () =>
  BOOKING_PLATFORMS.map((id) => ({
    id,
    label: BOOKINGS_MAP.platforms[id].label,
    verified: BOOKINGS_MAP.platforms[id].verified,
  }));

export async function GET(): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return NextResponse.json({ error: "sign in to import bookings" }, { status: 401 });
  const say = await words();
  try {
    return NextResponse.json({
      platforms: platforms(),
      ...(await bookingsView(session.account_id, say)),
    });
  } catch (error) {
    return onError(error, session.account_id, say);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return NextResponse.json({ error: "sign in to import bookings" }, { status: 401 });
  const denied = requireRole(session, "data.import");
  if (denied) return denied;
  const say = await words();
  try {
    const body = (await request.json().catch(() => null)) as {
      csv?: unknown;
      platform?: unknown;
      currency?: unknown;
      date_order?: unknown;
      decimal_style?: unknown;
    } | null;
    if (typeof body?.csv !== "string" || body.csv.trim() === "") {
      return NextResponse.json({ error: say.tr("bookings.refuse.noText") }, { status: 422 });
    }
    const platform = typeof body.platform === "string" ? body.platform : "";
    if (!isBookingPlatform(platform)) {
      return NextResponse.json({ error: say.tr("bookings.refuse.whichSystem") }, { status: 422 });
    }
    const dateOrder =
      body.date_order === "dmy" || body.date_order === "mdy" ? body.date_order : null;
    const currency =
      typeof body.currency === "string" && body.currency.trim() !== "" ? body.currency : null;
    const outcome = await importBookings(session.account_id, body.csv, {
      platform,
      currency,
      dateOrder,
      decimalStyle: isDecimalStyle(body.decimal_style) ? body.decimal_style : null,
    });
    return NextResponse.json(
      {
        ...outcome,
        derived: outcome.derived.map((d) => ({
          field_key: d.field_key,
          outcome: d.outcome,
          ...(d.outcome === "refused" ? { reason: d.reason } : {}),
        })),
        view: await bookingsView(session.account_id, say),
      },
      { status: 201 },
    );
  } catch (error) {
    return onError(error, session.account_id, say);
  }
}
