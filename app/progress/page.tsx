// /progress — goal progress and alert mode (Session J, P3-42..47).

import type { Metadata } from "next";
import { ProgressScreen } from "../../components/care/ProgressScreen";

export const metadata: Metadata = { title: "Goal progress — Ledgerline" };

export default function ProgressPage() {
  return <ProgressScreen />;
}
