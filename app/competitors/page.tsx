// /competitors — Insights · Competitors (feature 35).

import type { Metadata } from "next";
import { CompetitorsScreen } from "../../components/competitors/CompetitorsScreen";

export const metadata: Metadata = { title: "Competitors — SYB" };

export default function CompetitorsPage() {
  return <CompetitorsScreen />;
}
