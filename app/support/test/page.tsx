// /support/test — a stand-in for the owner's website, with the widget
// embedded the way a customer would meet it (Phase 4 Session B's
// done-when: "a stranger asks a question on a test page").

import type { Metadata } from "next";
import { WidgetTestPage } from "../../../components/support/WidgetTestPage";

export const metadata: Metadata = { title: "Widget test page — SYB" };

export default function SupportTestPage() {
  return <WidgetTestPage />;
}
