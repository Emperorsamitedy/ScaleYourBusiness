"use client";

// The app's one navigation — ux-spec §3: "a single persistent left rail on
// desktop, collapsing to a bottom bar on mobile, with at most five
// entries", carrying exactly one badge, the approval count, "because that
// is the only thing that is ever the owner's turn."
//
// Before this, every screen drew its own footer links and several features
// (customers, the website, the chat) could only be reached by typing a
// URL. Now every owner screen sits in one of five places, and a section
// with several screens shows them as tabs at the top. Pages keep their own
// content; nothing here changes what a page does.
//
// Shown only on the owner's screens: never on the landing, the intake (a
// focused flow by design), sign-in, the operator panel or the widget test
// page.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface Tab {
  href: string;
  label: string;
}

interface Section {
  key: string;
  label: string;
  /** Where clicking the section goes. */
  href: string;
  tabs: Tab[];
}

export const SECTIONS: readonly Section[] = [
  {
    key: "approve",
    label: "To approve",
    href: "/proposals",
    tabs: [{ href: "/proposals", label: "Waiting for you" }],
  },
  {
    key: "insights",
    label: "Insights",
    href: "/report",
    tabs: [
      { href: "/report", label: "Report" },
      { href: "/watch", label: "Watching" },
      { href: "/progress", label: "Goals" },
      { href: "/hours", label: "Trading hours" },
      { href: "/blindspots", label: "Blindspots" },
    ],
  },
  {
    key: "grow",
    label: "Grow",
    href: "/content",
    tabs: [
      { href: "/content", label: "Content" },
      { href: "/site", label: "Website" },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    href: "/customers",
    tabs: [
      { href: "/customers", label: "Customers" },
      { href: "/support", label: "Support" },
    ],
  },
  {
    key: "business",
    label: "Your business",
    href: "/profile",
    tabs: [
      { href: "/profile", label: "Fact sheet" },
      { href: "/connections", label: "Connections" },
      { href: "/mode", label: "How I work" },
      { href: "/history", label: "History" },
    ],
  },
];

/** Screens that are part of the app but no section's tab (the owner's chat). */
const LOOSE_ROUTES = ["/chat"];

const matches = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Pure: the section a path belongs to, or null when it isn't an owner screen. */
export function sectionFor(path: string): Section | null {
  if (path.startsWith("/support/test")) return null; // the stand-in for an owner's own site
  return SECTIONS.find((s) => s.tabs.some((t) => matches(path, t.href))) ?? null;
}

/** Pure: whether a path shows the app's navigation at all. */
export function showsNav(path: string): boolean {
  return sectionFor(path) !== null || LOOSE_ROUTES.some((r) => matches(path, r));
}

function ApprovalCount() {
  const [count, setCount] = useState<number | null>(null);
  const path = usePathname();
  useEffect(() => {
    let alive = true;
    void fetch("/api/proposals")
      .then(async (res) => {
        if (!res.ok) return;
        const j = (await res.json()) as { pending_count?: number };
        if (alive && typeof j.pending_count === "number") setCount(j.pending_count);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]); // refreshed on every move, so a decision just made is reflected
  if (!count) return null;
  return (
    <span className="nav-badge" aria-label={`${count} waiting for you`}>
      {count}
    </span>
  );
}

function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="nav-foot-link"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        router.push("/login");
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  if (!showsNav(path)) return <>{children}</>;
  const current = sectionFor(path);

  return (
    <div className="app-frame">
      <nav className="app-rail" aria-label="Main">
        <Link href="/report" className="app-rail-mark">
          Ledgerline
        </Link>
        <ul className="app-rail-list">
          {SECTIONS.map((s) => {
            const active = current?.key === s.key;
            return (
              <li key={s.key}>
                <Link
                  href={s.href}
                  className={`app-rail-item${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="app-rail-label">{s.label}</span>
                  {s.key === "approve" && <ApprovalCount />}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="app-rail-foot">
          <Link
            href="/chat"
            className={`nav-foot-link${matches(path, "/chat") ? " active" : ""}`}
            aria-current={matches(path, "/chat") ? "page" : undefined}
          >
            Ask me anything
          </Link>
          <SignOut />
        </div>
      </nav>

      <div className="app-main">
        {current && current.tabs.length > 1 && (
          <nav className="app-tabs" aria-label={current.label}>
            {current.tabs.map((t) => {
              const active = matches(path, t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={`app-tab${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        )}
        {children}
      </div>
    </div>
  );
}
