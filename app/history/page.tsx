// /history — the scorecard and suggestion record (Session E).

import type { Metadata } from "next";
import { HistoryScreen } from "../../components/trust/HistoryScreen";

export const metadata: Metadata = { title: "The record — Ledgerline" };

export default function HistoryPage() {
  return <HistoryScreen />;
}
