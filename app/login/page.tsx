// /login — P1-49. Server wrapper; the form is a client component.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginScreen } from "../../components/auth/Login";
import { configuredProviders } from "../../lib/auth/oauth";
import { pickerContext } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signIn") };
}

export default async function LoginPage() {
  const picker = await pickerContext();
  return (
    <LoginScreen
      providers={configuredProviders()}
      languages={picker.data.languages}
      language={picker.data.language}
    />
  );
}
