import { AppFrame } from "../components/nav/AppFrame";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, Geist, Geist_Mono, IBM_Plex_Mono, Zilla_Slab } from "next/font/google";
import "./globals.css";
import "./sheet.css";

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

// The sheet system (ux-spec §2): Zilla Slab for the one display figure
// or heading per sheet, Archivo for prose, IBM Plex Mono for every
// figure and label. The owner screens move over surface by surface;
// until then they keep Geist/Satoshi above.
const zilla = Zilla_Slab({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600"],
  variable: "--font-zilla",
  display: "swap",
});

const archivo = Archivo({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  variable: "--font-archivo",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ledgerline",
  description: "Find out where your business actually leaks money.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${zilla.variable} ${archivo.variable} ${plexMono.variable}`}
    >
      <head>
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@700,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
