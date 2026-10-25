// The landing page — the owner's landing design (2026-10-17); the price
// on every button is the price checkout charges.

import type { Metadata } from "next";
import { Landing } from "@/components/marketing/Landing";
import { reportPrice } from "@/lib/payments/stripe";
import "./landing.css";

export const metadata: Metadata = {
  title: "SYB — a blood test for your business",
  description:
    "36 checks on your sales, bookings, payments and ads, every leak priced in euros, and a signed report.",
};

export default function Home() {
  return <Landing price={reportPrice()} />;
}
