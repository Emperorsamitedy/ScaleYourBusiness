// The bookings API — specs/bookings.md §3–5.
//
//   GET   /api/bookings   what has been imported, and the 28-day measures per source
//   POST  /api/bookings   { csv, platform, currency?, date_order?, decimal_style? }: import one export
//
// Importing measurement into an account is an account-level act, like
// connecting a source, so both need a signed-in session. Nothing here logs
// a request body: an export carries client names and emails, which are
// read once, hashed or dropped, and never stored or echoed back.

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

const AUTH_COOKIE = "syb_session";

async function signedIn(): Promise<AuthedSession | null> {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof BookingImportError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // The error's name only: a message could quote a cell of the file.
  console.error(
    JSON.stringify({
      event: "bookings_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
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
  try {
    return NextResponse.json({
      platforms: platforms(),
      ...(await bookingsView(session.account_id)),
    });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return NextResponse.json({ error: "sign in to import bookings" }, { status: 401 });
  const denied = requireRole(session, "data.import");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as {
      csv?: unknown;
      platform?: unknown;
      currency?: unknown;
      date_order?: unknown;
      decimal_style?: unknown;
    } | null;
    if (typeof body?.csv !== "string" || body.csv.trim() === "") {
      return NextResponse.json({ error: "the export's text is required" }, { status: 422 });
    }
    const platform = typeof body.platform === "string" ? body.platform : "";
    if (!isBookingPlatform(platform)) {
      return NextResponse.json({ error: "say which booking system it came from" }, { status: 422 });
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
        view: await bookingsView(session.account_id),
      },
      { status: 201 },
    );
  } catch (error) {
    return onError(error, session.account_id);
  }
}
