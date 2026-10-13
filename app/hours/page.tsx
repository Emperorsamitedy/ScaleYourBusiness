// /hours — trading hours (Phase 2 Session F, P2-26..30).

import type { Metadata } from "next";
import { HoursScreen } from "../../components/hours/HoursScreen";

export const metadata: Metadata = { title: "Trading hours — Ledgerline" };

export default function HoursPage() {
  return <HoursScreen />;
}
