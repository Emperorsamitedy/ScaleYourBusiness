import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Type per docs/DESIGN.md (Ember Grid). Geist carries everything human —
// chosen for its numerals, because a financial interface lives or dies on
// how a decimal point looks. Geist Mono is machine truth: field keys,
// provenance, timestamps. Satoshi (loaded below) is the display face, used
// only on headlines where the product needs a voice rather than a UI.
const sans = Geist({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ledgerline",
  description: "Find out where your business actually leaks money.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@700,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
