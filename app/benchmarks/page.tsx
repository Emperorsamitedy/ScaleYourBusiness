// /benchmarks — Insights · Compared with similar businesses (idea 44).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BenchmarksScreen } from "../../components/benchmarks/BenchmarksScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("benchmarks.meta");
  return { title: t("title") };
}

export default function BenchmarksPage() {
  return <BenchmarksScreen />;
}
