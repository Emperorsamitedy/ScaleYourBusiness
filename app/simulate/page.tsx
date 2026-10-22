// /simulate — Grow · Campaign simulator (feature 36): before anything is
// spent or sent, the likely range of each campaign option from the
// business's own numbers, side by side.

import type { Metadata } from "next";
import { SimulateScreen } from "../../components/simulate/SimulateScreen";

export const metadata: Metadata = { title: "Campaign simulator — Ledgerline" };

export default function SimulatePage() {
  return <SimulateScreen />;
}
