// /privacy — a placeholder until SYB supplies the privacy notice.

import type { Metadata } from "next";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export const metadata: Metadata = { title: "Privacy notice — SYB" };

export default function PrivacyPage() {
  return <LegalPlaceholder label="Privacy" title="Privacy notice" />;
}
