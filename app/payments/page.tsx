// /payments — Insights · Payments (P6-05): payments SYB prepares and the
// owner makes in their own bank. SYB never moves money (rule 26 amended).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PaymentsScreen } from "../../components/payments/PaymentsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("payments.meta");
  return { title: t("title") };
}

export default function PaymentsPage() {
  return <PaymentsScreen />;
}
