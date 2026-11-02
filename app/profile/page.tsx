// The fact sheet — P1-59/60. Server wrapper; the screen is a client
// component reading GET /api/profile.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { FactSheetScreen } from "@/components/profile/FactSheet";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("factsheet.meta");
  return { title: t("title") };
}

export default function ProfilePage() {
  return <FactSheetScreen />;
}
