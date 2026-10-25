import { AppFrame } from "../components/nav/AppFrame";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, IBM_Plex_Mono, Zilla_Slab } from "next/font/google";
import "./globals.css";
import "./sheet.css";

// The sheet system's three faces (specs/ux-spec-v1.md §2), and only
// these: Zilla Slab for the one display figure or heading per sheet,
// Archivo for prose, IBM Plex Mono for every figure and label.
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
  title: "SYB",
  description: "Find out where your business actually leaks money.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${zilla.variable} ${archivo.variable} ${plexMono.variable}`}>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
