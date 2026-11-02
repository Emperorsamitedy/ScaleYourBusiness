// /carts — Customers · Abandoned carts: what was left, and who may be reminded (idea 47).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CartsScreen } from "../../components/carts/CartsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("carts.meta");
  return { title: t("title") };
}

export default function CartsPage() {
  return <CartsScreen />;
}
