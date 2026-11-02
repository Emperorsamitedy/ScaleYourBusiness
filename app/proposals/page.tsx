// /proposals — the approval queue (P3-05).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { QueueScreen } from "../../components/proposals/QueueScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("proposals.meta");
  return { title: t("title") };
}

export default function ProposalsPage() {
  return <QueueScreen />;
}
