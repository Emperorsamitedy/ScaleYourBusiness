// /blindspots — customer blindspots (Phase 2 Session G, P2-32..37).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BlindspotsScreen } from "../../components/blindspots/BlindspotsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("blindspots.meta");
  return { title: t("title") };
}

export default function BlindspotsPage() {
  return <BlindspotsScreen />;
}
