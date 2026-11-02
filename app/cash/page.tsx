// /cash — Insights · Cash flow (Phase 5 Session B, P5-10).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CashScreen } from "../../components/cash/CashScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("cash.meta");
  return { title: t("title") };
}

export default function CashPage() {
  return <CashScreen />;
}
