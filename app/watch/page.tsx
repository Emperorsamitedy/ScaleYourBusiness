// /watch — the watching status screen (P1-47).

import type { Metadata } from "next";
import { WatchScreen } from "../../components/watch/WatchScreen";

export const metadata: Metadata = { title: "Watching — Ledgerline" };

export default function WatchPage() {
  return <WatchScreen />;
}
