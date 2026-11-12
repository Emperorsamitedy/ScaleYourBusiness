// The price book — the multi-market spec Part B. Prices are data, never
// constants in code.
//
//   resolvePrice     the row that prices a tier for a billing country on a
//                    day: the country's own enabled row, else the default
//                    ("*") row
//   lockSubscription resolves the price at signup and copies it onto the
//                    subscription, where a trigger keeps it for life (§B.3);
//                    a billing/VAT country mismatch is flagged for a person
//                    and priced at the dearer market, never the cheaper one
//   revisePrice      the annual reviewed change (§B.3): closes the old row,
//                    opens a new one, writes the changelog — never automatic
//   enablePriceBook  switches a country's rows on, refused until every
//                    per-tier usage quota is confirmed (§B.4); the same rule
//                    is the startup check (priceBookStartupCheck)
//
// Choosing between two markets compares their PPP indices, never their
// prices through an exchange rate (§A.2: EUR is never a comparison basis).

import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { priceBook, priceBookChanges, subscriptions, usageQuotas } from "../../db/schema";
import { assertProcessorAmount, roundPrice } from "../core/currency-table";
import { isIsoCurrency } from "../core/money";
import { segmentOf } from "../segments/read";
import { tierAllowed } from "../segments/segment";

export type PriceRow = typeof priceBook.$inferSelect;
export type Tier = PriceRow["tier"];
export type Subscription = typeof subscriptions.$inferSelect;

export class PriceBookError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "PriceBookError";
    this.status = status;
  }
}

const ISO = /^[A-Z]{2}$/;
const PPP = /^\d{1,3}(\.\d{1,4})?$/;

/** "0.52" vs "1.00" — compared as scaled integers, never floats. */
function pppUnits(s: string): bigint {
  if (!PPP.test(s)) throw new PriceBookError(`"${s}" isn't a PPP index`, 422);
  const [w, f = ""] = s.split(".");
  return BigInt(`${w}${f.padEnd(4, "0")}`);
}

/** The row pricing `tier` for `country` on `day`: the country's enabled row, else the default. */
export async function resolvePrice(tier: Tier, country: string, day: string): Promise<PriceRow> {
  const live = (c: string) =>
    and(
      eq(priceBook.tier, tier),
      eq(priceBook.country, c),
      eq(priceBook.enabled, true),
      lte(priceBook.effective_from, day),
      or(isNull(priceBook.effective_to), gt(priceBook.effective_to, day)),
    );
  for (const c of [country.toUpperCase(), "*"]) {
    const [row] = await db
      .select()
      .from(priceBook)
      .where(live(c))
      .orderBy(desc(priceBook.effective_from))
      .limit(1);
    if (row) return row;
  }
  throw new PriceBookError(`no price is set for ${tier}`, 500);
}

/**
 * §B.3: the price, resolved at signup from the billing country and locked
 * for the subscription's lifetime. When the VAT country differs, both are
 * resolved and the dearer market (higher PPP index) prices it, flagged for
 * a person — never silently the cheaper rate.
 */
export async function lockSubscription(args: {
  profileId: string;
  tier: Tier;
  billingCountry: string;
  vatCountry: string;
  now?: Date;
  /** §8 lifecycle: "incomplete" until the checkout's webhook; default "active" as before. */
  status?: string;
  billingInterval?: "month" | "year";
  /** §8.3: an extra business names the subscription it rides on. */
  parentSubscriptionId?: string | null;
  /** A downgrade keeps the Stripe subscription it moves. */
  stripe?: { customer: string | null; subscription: string | null };
}): Promise<Subscription> {
  const billing = args.billingCountry.trim().toUpperCase();
  const vat = args.vatCountry.trim().toUpperCase();
  if (!ISO.test(billing) || !ISO.test(vat)) {
    throw new PriceBookError("billing and VAT countries are two-letter codes", 422);
  }
  // §C: a sole operation subscribes to Watch only.
  const segment = (await segmentOf(args.profileId)).segment;
  if (!tierAllowed(segment, args.tier)) {
    throw new PriceBookError(
      segment === "micro_sole"
        ? "a sole trader's plan is Watch"
        : "this business is beyond what SYB serves in v1 — it joins the waitlist",
      409,
    );
  }
  const day = (args.now ?? new Date()).toISOString().slice(0, 10);
  const byBilling = await resolvePrice(args.tier, billing, day);
  let row = byBilling;
  let needsReview = false;
  if (vat !== billing) {
    needsReview = true;
    const byVat = await resolvePrice(args.tier, vat, day);
    if (pppUnits(byVat.ppp_index) > pppUnits(byBilling.ppp_index)) row = byVat;
  }
  assertProcessorAmount({ amount_minor: row.list_amount_minor, currency: row.currency });
  const [sub] = await db
    .insert(subscriptions)
    .values({
      profile_id: args.profileId,
      tier: args.tier,
      billing_country: billing,
      vat_country: vat,
      currency: row.currency,
      price_amount_minor: row.list_amount_minor,
      price_book_id: row.id,
      needs_review: needsReview,
      ...(args.now ? { locked_at: args.now.toISOString() } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.billingInterval ? { billing_interval: args.billingInterval } : {}),
      ...(args.parentSubscriptionId ? { parent_subscription_id: args.parentSubscriptionId } : {}),
      ...(args.stripe
        ? {
            stripe_customer_id: args.stripe.customer,
            stripe_subscription_id: args.stripe.subscription,
          }
        : {}),
    })
    .returning();
  return sub!;
}

/**
 * §B.3: the annual reviewed change. The current row closes the day before
 * the new one takes effect; the new amount is rounded to the currency's
 * price step (HUF: 500 Ft); the changelog says who reviewed it and why.
 * Existing subscriptions keep the price they locked.
 */
export async function revisePrice(args: {
  tier: Tier;
  country: string;
  amountMinor: number;
  pppIndex: string;
  effectiveFrom: string;
  reviewedBy: string;
  reason: string;
}): Promise<PriceRow> {
  if (args.reviewedBy.trim() === "" || args.reason.trim() === "") {
    throw new PriceBookError("a price change names who reviewed it and why", 422);
  }
  pppUnits(args.pppIndex);
  const country = args.country.toUpperCase();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(priceBook)
      .where(
        and(
          eq(priceBook.tier, args.tier),
          eq(priceBook.country, country),
          isNull(priceBook.effective_to),
        ),
      )
      .orderBy(desc(priceBook.effective_from))
      .limit(1);
    if (!current) throw new PriceBookError(`no current ${args.tier} price for ${country}`, 404);
    if (args.effectiveFrom <= current.effective_from) {
      throw new PriceBookError("a new price takes effect after the current one began", 422);
    }
    if (!isIsoCurrency(current.currency)) throw new PriceBookError("bad currency", 500);
    const amount = roundPrice(args.amountMinor, current.currency);
    await tx
      .update(priceBook)
      .set({ effective_to: args.effectiveFrom })
      .where(eq(priceBook.id, current.id));
    const [next] = await tx
      .insert(priceBook)
      .values({
        tier: args.tier,
        country,
        currency: current.currency,
        list_amount_minor: amount,
        ppp_index: args.pppIndex,
        effective_from: args.effectiveFrom,
        enabled: current.enabled,
      })
      .returning();
    await tx.insert(priceBookChanges).values({
      price_book_id: next!.id,
      change: {
        replaces: current.id,
        from_minor: current.list_amount_minor,
        to_minor: amount,
        currency: current.currency,
        ppp_from: current.ppp_index,
        ppp_to: args.pppIndex,
        effective_from: args.effectiveFrom,
      },
      reviewed_by: args.reviewedBy.trim(),
      reason: args.reason.trim(),
    });
    return next!;
  });
}

/** §B.4: every per-tier quota confirmed? The gate for any country's own prices. */
export async function quotasConfirmed(): Promise<boolean> {
  const rows = await db.select({ confirmed: usageQuotas.confirmed }).from(usageQuotas);
  return rows.length > 0 && rows.every((r) => r.confirmed);
}

/** Switch a country's price book on — refused until the quotas are confirmed (§B.4). */
export async function enablePriceBook(country: string, by: string): Promise<number> {
  if (by.trim() === "") throw new PriceBookError("say who is switching the prices on", 422);
  if (!(await quotasConfirmed())) {
    throw new PriceBookError(
      "the per-tier usage quotas must be confirmed before a country's prices go live (margin guard)",
    );
  }
  const rows = await db
    .update(priceBook)
    .set({ enabled: true })
    .where(and(eq(priceBook.country, country.toUpperCase()), eq(priceBook.enabled, false)))
    .returning({ id: priceBook.id });
  for (const r of rows) {
    await db.insert(priceBookChanges).values({
      price_book_id: r.id,
      change: { enabled: true },
      reviewed_by: by.trim(),
      reason: "country prices switched on",
    });
  }
  return rows.length;
}

/**
 * §B.4's startup check: a country's own prices enabled while any quota is
 * unconfirmed is a configuration error, and the server refuses to start
 * with it (instrumentation.ts). Returns the problem, or null.
 */
export async function priceBookStartupCheck(): Promise<string | null> {
  const enabled = await db
    .select({ country: priceBook.country })
    .from(priceBook)
    .where(and(eq(priceBook.enabled, true)))
    .orderBy(asc(priceBook.country));
  const countries = [...new Set(enabled.map((r) => r.country).filter((c) => c !== "*"))];
  if (countries.length === 0) return null;
  if (await quotasConfirmed()) return null;
  return `price book enabled for ${countries.join(", ")} while the per-tier usage quotas are unconfirmed — confirm them or switch those prices off`;
}
