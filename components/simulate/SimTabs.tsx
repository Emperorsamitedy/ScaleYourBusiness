// The simulator's two halves under one Grow screen: the campaign simulator
// (feature 36) and what-if pricing (idea 43). Plain links, so each half has
// its own address (/simulate, /simulate?tab=pricing) and the back button
// works; the current one is marked for assistive tech as the page.
//
// L-3b: the tab names are "simulate.tabs" in the reader's language.

import Link from "next/link";
import { useTranslations } from "next-intl";

export type SimTab = "campaigns" | "pricing";

const TABS: { key: SimTab; href: string }[] = [
  { key: "campaigns", href: "/simulate" },
  { key: "pricing", href: "/simulate?tab=pricing" },
];

export function SimTabs({ current }: { current: SimTab }) {
  const t = useTranslations("simulate.tabs");
  return (
    <nav className="sim-tabs" aria-label={t("aria")}>
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`sim-tab${tab.key === current ? " on" : ""}`}
          aria-current={tab.key === current ? "page" : undefined}
        >
          {t(tab.key)}
        </Link>
      ))}
    </nav>
  );
}
