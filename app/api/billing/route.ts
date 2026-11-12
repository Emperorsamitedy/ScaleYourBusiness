// POST /api/billing — the owner's plan (v1 spec §8.3, §8.5).
//
//   { action: "subscribe", tier, interval }  → { checkout_url }
//   { action: "portal" }                     → { url }  the card, in Stripe
//   { action: "downgrade" }                  → Watch, offered before cancel
//   { action: "cancel", reason? }            → ends at the period's end
//   { action: "resume" }                     → after a dormant pause
//
// The owner's ("billing.manage"), from our own page. With no Stripe key,
// every action answers 503 and nothing is charged.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { isSubscriptionTier } from "../../../lib/billing/plans";
import { PriceBookError } from "../../../lib/billing/price-book";
import { PaymentError, paymentsConfigured } from "../../../lib/billing/stripe";
import {
  billingPortal,
  cancelSubscription,
  downgradeToWatch,
  resumeBilling,
  startSubscription,
} from "../../../lib/billing/subscribe";
import { countryCode } from "../../../lib/core/country";
import { readCurrentField } from "../../../lib/profile/field-store";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "change this from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no session" }, { status: 401 });
  const denied = requireRole(access, "billing.manage");
  if (denied) return denied;
  if (!paymentsConfigured()) return NextResponse.json({ error: "not_armed" }, { status: 503 });

  let body: { action?: unknown; tier?: unknown; interval?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "subscribe": {
        const tier = String(body.tier ?? "");
        if (!isSubscriptionTier(tier))
          return NextResponse.json({ error: "pick a plan" }, { status: 422 });
        const raw = await readCurrentField<string>(access.profile_id, "legal.country");
        const country = (typeof raw?.value === "string" && countryCode(raw.value)) || "PT";
        const out = await startSubscription({
          profileId: access.profile_id,
          tier,
          interval: body.interval === "year" ? "year" : "month",
          billingCountry: country,
          vatCountry: country,
          appUrl: origin,
        });
        return NextResponse.json({ checkout_url: out.checkout_url });
      }
      case "portal":
        return NextResponse.json(await billingPortal(access.profile_id, `${origin}/billing`));
      case "downgrade":
        return NextResponse.json(await downgradeToWatch(access.profile_id));
      case "cancel":
        return NextResponse.json(
          await cancelSubscription(
            access.profile_id,
            typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
          ),
        );
      case "resume":
        return NextResponse.json(await resumeBilling(access.profile_id));
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof PaymentError || error instanceof PriceBookError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "billing_action_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
