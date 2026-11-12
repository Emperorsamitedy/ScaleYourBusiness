// /ladder — what SYB may do in this business, right now (the v1 spec §4.6):
// every capability as a row with its station, its ledger record, and its
// raise or lower control. One tap away from every page (the menu).

import type { Metadata } from "next";
import { LadderScreen } from "../../components/ladder/LadderScreen";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ladder")("meta.title") };
}

export default function LadderPage() {
  return <LadderScreen />;
}
