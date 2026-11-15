// /settings/alerts — Your business · Alerts and modules (2026-11-15): the
// module switches, the weekly summary and phone alerts, moved here from
// the foot of Watching so that screen says only what is being watched.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WatchSettingsScreen } from "../../../components/watch/WatchScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("alerts.meta");
  return { title: t("title") };
}

export default function AlertsPage() {
  return <WatchSettingsScreen />;
}
