// /patterns — Insights · Seasons & bundles (ideas 46 and 48).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PatternsScreen } from "../../components/patterns/PatternsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("patterns.meta");
  return { title: t("title") };
}

export default function PatternsPage() {
  return <PatternsScreen />;
}
