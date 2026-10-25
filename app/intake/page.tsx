// Intake — the signature screen (specs/ux-spec-v1.md §4).
// Server wrapper; all interaction lives in the client stage.

import type { Metadata } from "next";
import { IntakeStage } from "@/components/intake/IntakeStage";

export const metadata: Metadata = {
  title: "Setting up the record — SYB",
};

export default function IntakePage() {
  return <IntakeStage />;
}
