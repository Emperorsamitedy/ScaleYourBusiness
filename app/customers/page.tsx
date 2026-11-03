// /customers — contacts, lifecycle and segments (Phase 4 Sessions A and E).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CustomersScreen } from "../../components/crm/CustomersScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("customers.meta");
  return { title: t("title") };
}

export default function CustomersPage() {
  return <CustomersScreen />;
}
