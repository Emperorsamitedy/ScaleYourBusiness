// The diagnosis report — Session G. Server wrapper; the screen is a
// client component reading GET /api/report.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ReportScreen } from "@/components/report/Report";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("report.meta");
  return { title: t("title") };
}

export default function ReportPage() {
  return <ReportScreen />;
}
