// /content — goals and the scheduled content queue (Session C).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ContentScreen } from "../../components/content/ContentScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("content.meta");
  return { title: t("title") };
}

export default function ContentPage() {
  return <ContentScreen />;
}
