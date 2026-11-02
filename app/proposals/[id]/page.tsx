// /proposals/<id> — one proposal's card, the page a phone alert opens (idea 53, I-53.5).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ProposalCard } from "../../../components/proposals/ProposalCard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("proposals.meta");
  return { title: t("one") };
}

export default async function ProposalCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalCard id={id} />;
}
