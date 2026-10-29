// /proposals/<id> — one proposal's card, the page a phone alert opens (idea 53, I-53.5).

import type { Metadata } from "next";
import { ProposalCard } from "../../../components/proposals/ProposalCard";

export const metadata: Metadata = { title: "Proposal — SYB" };

export default async function ProposalCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalCard id={id} />;
}
