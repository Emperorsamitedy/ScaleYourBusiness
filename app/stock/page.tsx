// /stock — Insights · Slow stock (feature 34).

import type { Metadata } from "next";
import { StockScreen } from "../../components/stock/StockScreen";

export const metadata: Metadata = { title: "Slow stock — Ledgerline" };

export default function StockPage() {
  return <StockScreen />;
}
