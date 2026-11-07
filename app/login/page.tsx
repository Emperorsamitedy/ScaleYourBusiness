// /login — P1-49. Server wrapper; the form is a client component.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginScreen } from "../../components/auth/Login";
import { configuredProviders } from "../../lib/auth/oauth";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signIn") };
}

export default function LoginPage() {
  return <LoginScreen providers={configuredProviders()} />;
}
