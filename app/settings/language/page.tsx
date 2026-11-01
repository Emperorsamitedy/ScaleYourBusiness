// /settings/language — Your business · Language and currency (L-1, TASKS-LANGUAGES.md).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LocaleSettings } from "../../../components/locale/LocaleSettings";
import { pickerContext } from "../../../lib/i18n/server";
import "../../auth.css";
import "../../locale.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("locale");
  return { title: t("meta") };
}

export default async function LanguageSettingsPage() {
  const picker = await pickerContext();
  return (
    <LocaleSettings
      data={picker.data}
      business={
        picker.business
          ? { language: picker.business.language, currency: picker.business.currency }
          : null
      }
    />
  );
}
