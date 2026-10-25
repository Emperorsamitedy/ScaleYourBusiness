// /support — the owner's customer-chat screen (Phase 4 Session B).

import type { Metadata } from "next";
import { SupportScreen } from "../../components/support/SupportScreen";

export const metadata: Metadata = { title: "Support — SYB" };

export default function SupportPage() {
  return <SupportScreen />;
}
