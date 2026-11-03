// /studio — Grow · Creative studio (P3-50, P3-51): the niche's longest-running ads and the creative brief.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { StudioScreen } from "../../components/studio/StudioScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("studio.meta");
  return { title: t("title") };
}

export default function StudioPage() {
  return <StudioScreen />;
}
