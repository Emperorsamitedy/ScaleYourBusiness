// /support/test — a stand-in for the owner's website, with the widget
// embedded the way a customer would meet it (Phase 4 Session B's
// done-when: "a stranger asks a question on a test page").

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WidgetTestPage } from "../../../components/support/WidgetTestPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("support.test.meta");
  return { title: t("title") };
}

export default function SupportTestPage() {
  return <WidgetTestPage />;
}
