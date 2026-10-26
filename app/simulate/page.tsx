// /simulate — Grow · Simulator. Two halves, each on its own address:
//   /simulate              the campaign simulator (feature 36): before anything
//                          is spent or sent, the likely range of each campaign
//                          option from the business's own numbers, side by side;
//   /simulate?tab=pricing  what-if pricing (idea 43): what a price change on one
//                          product or service can lose and still pay, and the
//                          range of outcomes under a stated customer response.
//                          Read-only: it never changes a price.

import type { Metadata } from "next";
import { PricingScreen } from "../../components/simulate/PricingScreen";
import { SimulateScreen } from "../../components/simulate/SimulateScreen";

export const metadata: Metadata = { title: "Simulator — SYB" };

export default async function SimulatePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const tab = (await searchParams).tab;
  return tab === "pricing" ? <PricingScreen /> : <SimulateScreen />;
}
