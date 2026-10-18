// /privacy — a placeholder until Ledgerline supplies the privacy notice.

import type { Metadata } from "next";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export const metadata: Metadata = { title: "Privacy notice — Ledgerline" };

export default function PrivacyPage() {
  return <LegalPlaceholder label="Privacy" title="Privacy notice" />;
}
