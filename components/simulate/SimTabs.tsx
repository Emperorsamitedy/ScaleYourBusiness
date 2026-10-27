// The simulator's two halves under one Grow screen: the campaign simulator
// (feature 36) and what-if pricing (idea 43). Plain links, so each half has
// its own address (/simulate, /simulate?tab=pricing) and the back button
// works; the current one is marked for assistive tech as the page.

import Link from "next/link";

export type SimTab = "campaigns" | "pricing";

const TABS: { key: SimTab; label: string; href: string }[] = [
  { key: "campaigns", label: "Campaigns", href: "/simulate" },
  { key: "pricing", label: "What-if pricing", href: "/simulate?tab=pricing" },
];

export function SimTabs({ current }: { current: SimTab }) {
  return (
    <nav className="sim-tabs" aria-label="Simulator">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`sim-tab${t.key === current ? " on" : ""}`}
          aria-current={t.key === current ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
