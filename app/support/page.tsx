// /support — the owner's customer-chat screen (Phase 4 Session B).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SupportScreen } from "../../components/support/SupportScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("support.meta");
  return { title: t("title") };
}

export default function SupportPage() {
  return <SupportScreen />;
}
