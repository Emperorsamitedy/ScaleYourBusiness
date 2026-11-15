// /home — Today · Home (2026-11-15): the first screen after sign-in. The
// screen is a client component reading the owner screens' own APIs.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HomeScreen } from "../../components/home/HomeScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home.meta");
  return { title: t("title") };
}

export default function HomePage() {
  return <HomeScreen />;
}
