// /mode — the mode decision screen (P1-43).

import type { Metadata } from "next";
import { ModeScreen } from "../../components/mode/ModeScreen";

export const metadata: Metadata = { title: "How I'll work — Ledgerline" };

export default function ModePage() {
  return <ModeScreen />;
}
