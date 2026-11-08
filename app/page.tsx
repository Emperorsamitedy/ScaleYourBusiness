// The landing page — the owner's landing design (2026-10-17); the price
// on every button is the price checkout charges. L-3d: its words are the
// "landing" catalogue, its figures in the reader's language.

import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Landing } from "@/components/marketing/Landing";
import { LANDING_FIGURES } from "@/components/marketing/words";
import { num } from "@/components/sheet/num";
import { isAppLocale } from "@/lib/i18n/locales";
import type { Tr } from "@/lib/i18n/tr";
import { reportPrice } from "@/lib/billing/stripe";
import "./landing.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = (await getTranslations("landing.meta" as "common")) as unknown as Tr;
  const raw = await getLocale();
  const locale = isAppLocale(raw) ? raw : "en";
  return {
    title: t("title"),
    description: t("description", { checks: num(LANDING_FIGURES.checks, 0, locale) }),
  };
}

export default function Home() {
  return <Landing price={reportPrice()} />;
}
