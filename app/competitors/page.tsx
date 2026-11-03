// /competitors — Insights · Competitors (feature 35).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CompetitorsScreen } from "../../components/competitors/CompetitorsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("competitors.meta");
  return { title: t("title") };
}

export default function CompetitorsPage() {
  return <CompetitorsScreen />;
}
