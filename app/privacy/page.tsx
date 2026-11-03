// /privacy — a placeholder until SYB supplies the privacy notice, with the
// facts that already hold about how the product handles data.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.privacy");
  return { title: t("meta") };
}

export default async function PrivacyPage() {
  const t = await getTranslations("legal.privacy");
  return (
    <LegalPlaceholder
      label={t("label")}
      title={t("title")}
      facts={
        <>
          <h2 className="au-sheet-label">{t("speakingHead")}</h2>
          <p>{t("speaking")}</p>
        </>
      }
    />
  );
}
