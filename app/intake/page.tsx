// Intake — the signature screen (specs/ux-spec-v1.md §4).
// Server wrapper; all interaction lives in the client stage.
//
// L-1 (TASKS-LANGUAGES.md): a new visitor — no language chosen in this
// browser and no interview under way — chooses the language and currency
// first. An interview already under way is never interrupted by it; its
// language and currency change in settings.

import type { Metadata } from "next";
import { IntakeStage } from "@/components/intake/IntakeStage";
import { FirstStepScreen } from "@/components/locale/FirstStepScreen";
import { pickerContext } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "Setting up the record — SYB",
};

export default async function IntakePage() {
  const picker = await pickerContext();
  if (!picker.chosen && !picker.access) return <FirstStepScreen data={picker.data} />;
  return <IntakeStage />;
}
