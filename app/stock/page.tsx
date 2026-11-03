// /stock — Insights · Stock: what runs out, and what isn't selling (feature 34, P5-05).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { StockScreen } from "../../components/stock/StockScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("stock.meta");
  return { title: t("title") };
}

export default function StockPage() {
  return <StockScreen />;
}
