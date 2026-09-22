// /proposals — the approval queue (P3-05).

import type { Metadata } from "next";
import { QueueScreen } from "../../components/proposals/QueueScreen";

export const metadata: Metadata = { title: "Proposals — Ledgerline" };

export default function ProposalsPage() {
  return <QueueScreen />;
}
