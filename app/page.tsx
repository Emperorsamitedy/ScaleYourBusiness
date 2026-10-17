// The landing page — ux-spec §7.1: the sample diagnosis sheet is the
// hero, and the price on the button is the price checkout charges.

import type { Metadata } from "next";
import { Landing } from "@/components/marketing/Landing";
import { reportPrice } from "@/lib/payments/stripe";
import "./landing.css";

export const metadata: Metadata = {
  title: "Ledgerline — find out where your shop loses money",
  description:
    "Answer questions about your shop and get a diagnosis: every figure checked against a range, every finding with its evidence, and the arithmetic shown.",
};

export default function Home() {
  return <Landing price={reportPrice()} />;
}
