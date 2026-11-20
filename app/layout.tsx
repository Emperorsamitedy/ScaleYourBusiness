import { AppFrame } from "../components/nav/AppFrame";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Archivo, IBM_Plex_Mono, Zilla_Slab } from "next/font/google";
import "./globals.css";
import "./sheet.css";

// The sheet system's three faces (specs/ux-spec-v1.md §2), and only
// these: Zilla Slab for the one display figure or heading per sheet,
// Archivo for prose, IBM Plex Mono for every figure and label. On the
// owner's screens two of them are used (2026-11-18): Archivo for
// everything read, the mono for figures; app/sheet.css holds the switch.
const zilla = Zilla_Slab({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
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
  title: "ScaleX",
  description: "Find out where your business actually leaks money.",
};

// L-1: the language comes from the language cookie through the status gate
// (i18n/request.ts); every screen below reads its words from that catalogue.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${zilla.variable} ${archivo.variable} ${plexMono.variable}`}>
      <body>
        <NextIntlClientProvider>
          <AppFrame>{children}</AppFrame>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
