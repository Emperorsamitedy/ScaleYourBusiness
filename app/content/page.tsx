// /content — goals and the scheduled content queue (Session C).

import type { Metadata } from "next";
import { ContentScreen } from "../../components/content/ContentScreen";

export const metadata: Metadata = { title: "Content — Ledgerline" };

export default function ContentPage() {
  return <ContentScreen />;
}
