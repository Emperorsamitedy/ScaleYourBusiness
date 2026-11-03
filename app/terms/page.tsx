// /terms — a placeholder until SYB supplies the terms of service.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.terms");
  return { title: t("meta") };
}

export default async function TermsPage() {
  const t = await getTranslations("legal.terms");
  return <LegalPlaceholder label={t("label")} title={t("title")} />;
}
