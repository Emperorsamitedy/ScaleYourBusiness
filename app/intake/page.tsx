// Intake — the signature screen (specs/ux-spec-v1.md §4).
// Server wrapper; all interaction lives in the client stage.
//
// L-1 (TASKS-LANGUAGES.md): a new visitor — no language chosen in this
// browser and no interview under way — chooses the language and currency
// first. An interview already under way is never interrupted by it; its
// language and currency change in settings.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { IntakeStage } from "@/components/intake/IntakeStage";
import { FirstStepScreen } from "@/components/locale/FirstStepScreen";
import { redirect } from "next/navigation";
import { resolveAccess } from "@/lib/auth/access";
import { pickerContext } from "@/lib/i18n/server";
import { profileKind } from "@/lib/ideas/keep";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("intake.meta");
  return { title: t("title") };
}

export default async function IntakePage() {
  // TASKS-IDEAS I-10: an idea isn't interviewed as a trading business; its plan is its page.
  const access = await resolveAccess();
  if (access && (await profileKind(access.profile_id)) === "idea") redirect("/idea/mine");
  const picker = await pickerContext();
  if (!picker.chosen && !picker.access) return <FirstStepScreen data={picker.data} />;
  return <IntakeStage />;
}
