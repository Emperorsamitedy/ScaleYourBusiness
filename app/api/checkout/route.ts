// POST /api/checkout — start paying for the report (P1-50).
//
// Session-scoped like everything else. Returns the Stripe Checkout URL;
// the browser goes there, Stripe takes the card, and the webhook —
// never this route, never the redirect — marks the payment real.

import { logSafeError } from "../../../lib/core/log-safe";
import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { PaymentError, startCheckout } from "../../../lib/payments/stripe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
    const profileId = (await resolveAccess())?.profile_id;
    if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
    const [profile] = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    if (!profile) return NextResponse.json({ error: "no intake session" }, { status: 401 });

    const appUrl = process.env.APP_URL || new URL(request.url).origin;
    const checkout = await startCheckout(profile.id, appUrl);
    return NextResponse.json(checkout);
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "checkout_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
