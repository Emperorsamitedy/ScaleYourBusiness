// /blindspots — customer blindspots (Phase 2 Session G, P2-32..37).

import type { Metadata } from "next";
import { BlindspotsScreen } from "../../components/blindspots/BlindspotsScreen";

export const metadata: Metadata = { title: "Blindspots — Ledgerline" };

export default function BlindspotsPage() {
  return <BlindspotsScreen />;
}
