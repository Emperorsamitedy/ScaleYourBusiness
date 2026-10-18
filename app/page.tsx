// The landing page — the owner's landing design (2026-10-17); the price
// on every button is the price checkout charges.

import type { Metadata } from "next";
import { Landing } from "@/components/marketing/Landing";
import { reportPrice } from "@/lib/payments/stripe";
import "./landing.css";

export const metadata: Metadata = {
  title: "Ledgerline — a blood test for your online store",
  description:
    "36 checks on your Shopify or WooCommerce store, every leak priced in euros, and a signed report.",
};

export default function Home() {
  return <Landing price={reportPrice()} />;
}
