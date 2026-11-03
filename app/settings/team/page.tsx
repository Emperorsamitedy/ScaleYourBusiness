// /settings/team — Your business · Team access: who can sign in (idea 52).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { TeamAccessScreen } from "../../../components/members/TeamAccessScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teamAccess.meta");
  return { title: t("title") };
}

export default function TeamAccessPage() {
  return <TeamAccessScreen />;
}
