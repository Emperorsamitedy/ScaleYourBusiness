// /signup — the same one-motion auth, met with sign-up words (P1-49).
// L-1, amended 2026-11-16: sign-up no longer stops for language and
// currency first. The language is a footer switcher here; the intake asks
// for both before its first question when they haven't been chosen
// (app/intake/page.tsx, TASKS-LANGUAGES.md).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginScreen } from "../../components/auth/Login";
import { configuredProviders } from "../../lib/auth/oauth";
import { redirect } from "next/navigation";
import { pickerContext } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signUp") };
}

export default async function SignupPage() {
  const picker = await pickerContext();
  // Already signed in to a business: straight into the app (ux-spec §7.0).
  if (picker.access?.session) redirect("/home");
  return (
    <LoginScreen
      variant="signup"
      providers={configuredProviders()}
      languages={picker.data.languages}
      language={picker.data.language}
    />
  );
}
