// /connections — the owner's data sources (P2-12).

import type { Metadata } from "next";
import { ConnectionsScreen } from "../../components/connections/ConnectionsScreen";

export const metadata: Metadata = { title: "Connections — SYB" };

export default function ConnectionsPage() {
  return <ConnectionsScreen />;
}
