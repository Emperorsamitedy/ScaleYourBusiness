// /mode — the mode decision screen (P1-43).

import type { Metadata } from "next";
import { ModeScreen } from "../../components/mode/ModeScreen";

export const metadata: Metadata = { title: "How I work — SYB" };

export default function ModePage() {
  return <ModeScreen />;
}
