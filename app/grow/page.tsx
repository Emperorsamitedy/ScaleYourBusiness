// /grow — Grow's front page: every tool, what it does, what to press next (2026-11-23).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GrowScreen } from "../../components/grow/GrowScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grow.meta");
  return { title: t("title") };
}

export default function GrowPage() {
  return <GrowScreen />;
}
