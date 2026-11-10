// /api/checkout — start paying for the report (P1-50).
//
// Session-scoped like everything else. POST returns the Stripe Checkout
// URL; the browser goes there, Stripe takes the card, and the webhook —
// never this route, never the redirect — marks the payment real.
//
// I-52a (owner, 2026-10-31): one bill for several businesses. GET lists
// the signed-in person's other businesses whose report isn't paid for,
// where they are an owner, with the prices. POST { also: [profile_id] }
// adds those to the same checkout, each at the extra price. A business
// is only ever added if the person's own verified email is an owner of
// it: the ids come from the browser, and the list they're checked
// against comes from the session.
//
// I-52e (owner, 2026-10-31): a person who has already paid for any
// business they own pays the extra price for this one too. That is also
// read from the session's own businesses, never from the request.

import { logSafeError } from "../../../lib/core/log-safe";
import { resolveAccess } from "../../../lib/auth/access";
import type { Access } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { membershipsFor } from "../../../lib/auth/members";
import type { AlsoBusiness } from "../../../lib/billing/stripe";
import {
  MAX_CHECKOUT_BUSINESSES,
  PaymentError,
  extraReportPrice,
  paidProfiles,
  paymentsConfigured,
  reportPrice,
  startCheckout,
} from "../../../lib/billing/stripe";
import { requireRole } from "../../../lib/auth/roles";

export interface CheckoutOptions {
  configured: boolean;
  price: { amount_minor: number; currency: string };
  extra_price: { amount_minor: number; currency: string };
  /** I-52e: what this business costs now: the extra price once another owned business is paid. */
  first_price: { amount_minor: number; currency: string };
  /** The person's other businesses they own whose report isn't paid for. */
  others: { profile_id: string; business: string | null }[];
}

/**
 * The person's businesses where they're an owner: the others not yet paid
 * for, and whether any other one is paid (I-52e). Nothing for an
 * anonymous intake.
 */
async function ownedBusinesses(
  access: Access,
): Promise<{ others: AlsoBusiness[]; paidBefore: boolean }> {
  const session = access.session;
  if (!session) return { others: [], paidBefore: false };
  const owned = (await membershipsFor(session.email)).filter(
    (m) => m.role === "owner" && m.profile_id !== null && m.account_id !== access.account_id,
  );
  const paid = await paidProfiles(owned.map((m) => m.profile_id!));
  return {
    others: owned
      .filter((m) => !paid.has(m.profile_id!))
      .map((m) => ({ profile_id: m.profile_id!, name: m.business })),
    paidBefore: paid.size > 0,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const access = await resolveAccess();
    if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
    const denied = requireRole(access, "billing.manage");
    if (denied) return denied;
    const { others, paidBefore } = await ownedBusinesses(access);
    const body: CheckoutOptions = {
      configured: paymentsConfigured(),
      price: await reportPrice(),
      extra_price: await extraReportPrice(),
      first_price: paidBefore ? await extraReportPrice() : await reportPrice(),
      others: others.map((o) => ({ profile_id: o.profile_id, business: o.name })),
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "checkout_options_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Security review 2026-11-09: same-origin, defense-in-depth beyond
  // SameSite=Lax, matching the pattern every other mutating route in the
  // codebase follows (lib/auth/same-origin) — this starts a real Stripe
  // checkout session, so it's worth the second check.
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "start checkout from our own page" }, { status: 403 });
  }
  try {
    // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
    const access = await resolveAccess();
    const profileId = access?.profile_id;
    if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
    const denied = requireRole(access, "billing.manage");
    if (denied) return denied;
    const [profile] = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    if (!profile) return NextResponse.json({ error: "no intake session" }, { status: 401 });

    // An empty body is the one-business checkout, as before.
    const raw = (await request.json().catch(() => null)) as { also?: unknown } | null;
    const asked = raw?.also ?? [];
    if (
      !Array.isArray(asked) ||
      asked.length >= MAX_CHECKOUT_BUSINESSES ||
      !asked.every((id): id is string => typeof id === "string")
    ) {
      return NextResponse.json(
        { error: "also must be a short list of business ids" },
        { status: 400 },
      );
    }
    const owned = await ownedBusinesses(access);
    let also: AlsoBusiness[] = [];
    if (asked.length > 0) {
      const allowed = new Map(owned.others.map((o) => [o.profile_id, o]));
      if (!asked.every((id) => allowed.has(id))) {
        return NextResponse.json(
          { error: "You can only add businesses you own whose report isn't paid for yet." },
          { status: 403 },
        );
      }
      also = asked.map((id) => allowed.get(id)!);
    }

    const appUrl = process.env.APP_URL || new URL(request.url).origin;
    const checkout = await startCheckout(profile.id, appUrl, also, owned.paidBefore);
    return NextResponse.json(checkout);
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "checkout_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
