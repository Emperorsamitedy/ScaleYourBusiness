// The diagnosis report — Session G. Server wrapper; the screen is a
// client component reading GET /api/report.

import type { Metadata } from "next";
import { ReportScreen } from "@/components/report/Report";

export const metadata: Metadata = {
  title: "Your diagnosis — Ledgerline",
};

export default function ReportPage() {
  return <ReportScreen />;
}
