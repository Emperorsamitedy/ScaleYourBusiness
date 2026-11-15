// /landing-v2 — the v2 landing page, a preview until the owner makes it
// the front page (specs/ux-spec-v1.md §7.1b). The first landing page at
// "/" is untouched. Plan prices are the price book's for an unknown
// market; if the book cannot be read the page still renders, with a dash
// where a price would be, rather than failing the whole page.

import type { Metadata } from "next";
import { LandingV2, type V2Prices } from "@/components/marketing/LandingV2";
import { planPrices } from "@/lib/billing/plans";
import { reportPrice } from "@/lib/billing/stripe";
import { requestLocale } from "@/lib/i18n/server";
import { trFor } from "@/lib/i18n/server-tr";
import "../landing-v2.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: trFor(locale, "landing")("meta.title"),
    description: trFor(locale, "landingV2")("hero.lede"),
    // A preview: not for search engines until it replaces the front page.
    robots: { index: false, follow: false },
  };
}

export default async function LandingV2Page() {
  const prices: V2Prices = { report: await reportPrice() };
  try {
    for (const p of await planPrices("*")) {
      prices[p.tier] = { amount_minor: p.monthly_minor, currency: p.currency };
    }
  } catch {
    // The price book is unreachable: the page shows a dash for each plan.
  }
  return <LandingV2 prices={prices} />;
}
