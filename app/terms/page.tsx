// /terms — a placeholder until SYB supplies the terms of service.

import type { Metadata } from "next";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export const metadata: Metadata = { title: "Terms — SYB" };

export default function TermsPage() {
  return <LegalPlaceholder label="Terms" title="Terms of service" />;
}
