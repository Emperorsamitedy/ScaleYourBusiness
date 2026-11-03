// /team — Insights · Team cover (Phase 5 Session E, P5-20; rule 28).
// Off by default: the screen says how to switch it on and shows nothing else.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { TeamScreen } from "../../components/team/TeamScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("team.meta");
  return { title: t("title") };
}

export default function TeamPage() {
  return <TeamScreen />;
}
