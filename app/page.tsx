// The front page — the v2 landing page (specs/ux-spec-v1.md §7.1b), made
// the front page on the owner's instruction (2026-11-16). One filmed scene
// per section behind the page; in front, the copy and one ScaleX screen per
// section. Its words are the "landingV2" catalogue (with a few of the first
// landing's), its figures in the reader's language. The first landing page
// is kept at /landing-v1.

import type { Metadata } from "next";
import { LandingV2 } from "@/components/marketing/LandingV2";
import { requestLocale } from "@/lib/i18n/server";
import { trFor } from "@/lib/i18n/server-tr";
import { landingV2Prices } from "@/lib/marketing/landing-v2-prices";
import "./landing-v2.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: trFor(locale, "landing")("meta.title"),
    description: trFor(locale, "landingV2")("hero.lede"),
  };
}

export default async function Home() {
  return <LandingV2 prices={await landingV2Prices()} />;
}
