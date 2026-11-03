// /connections — the owner's data sources (P2-12).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ConnectionsScreen } from "../../components/connections/ConnectionsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("connections.meta");
  return { title: t("title") };
}

export default function ConnectionsPage() {
  return <ConnectionsScreen />;
}
