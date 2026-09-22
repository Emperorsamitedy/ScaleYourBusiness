// /site — website changes, preview-first (Session F).

import type { Metadata } from "next";
import { SiteScreen } from "../../components/site/SiteScreen";

export const metadata: Metadata = { title: "Your site — Ledgerline" };

export default function SitePage() {
  return <SiteScreen />;
}
