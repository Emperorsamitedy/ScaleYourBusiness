// /customers — contacts, lifecycle and segments (Phase 4 Sessions A and E).

import type { Metadata } from "next";
import { CustomersScreen } from "../../components/crm/CustomersScreen";

export const metadata: Metadata = { title: "Customers — SYB" };

export default function CustomersPage() {
  return <CustomersScreen />;
}
