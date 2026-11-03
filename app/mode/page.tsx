// /mode — the mode decision screen (P1-43).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ModeScreen } from "../../components/mode/ModeScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mode.meta");
  return { title: t("title") };
}

export default function ModePage() {
  return <ModeScreen />;
}
