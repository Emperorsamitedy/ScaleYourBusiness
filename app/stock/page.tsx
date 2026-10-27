// /stock — Insights · Stock: what runs out, and what isn't selling (feature 34, P5-05).

import type { Metadata } from "next";
import { StockScreen } from "../../components/stock/StockScreen";

export const metadata: Metadata = { title: "Stock — SYB" };

export default function StockPage() {
  return <StockScreen />;
}
