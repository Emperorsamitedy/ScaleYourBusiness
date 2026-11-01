// /signup — the same one-motion auth, met with sign-up words (P1-49).
// L-1: a browser that hasn't chosen a language and currency yet chooses
// them first (TASKS-LANGUAGES.md); then the email form, in that language.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginScreen } from "../../components/auth/Login";
import { FirstStepScreen } from "../../components/locale/FirstStepScreen";
import { pickerContext } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signUp") };
}

export default async function SignupPage() {
  const picker = await pickerContext();
  if (!picker.chosen) return <FirstStepScreen data={picker.data} signIn />;
  return <LoginScreen variant="signup" />;
}
