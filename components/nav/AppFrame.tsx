"use client";

// The app's one navigation — the owner's menu design (2026-10-17) on
// ux-spec §3: an ink rail with the wordmark, the business, and the live
// state ("WATCHING · DAY 19 / 28") over a cobalt rule; then five labelled
// groups listing every screen, each with its count where one exists; and
// "Ask me anything →" at the foot. No icons and no section tabs: every
// screen is one click from the rail.
//
// Two screens are focused views with their own masthead and no rail —
// the report and the approval queue (their designs). The landing, the
// intake, sign-in and the operator panel never show it.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { NavCounts } from "../../app/api/nav/route";

interface Item {
  href: string;
  label: string;
  count?: (c: NavCounts) => string | null;
}

interface Group {
  key: string;
  label: string;
  items: Item[];
}

const n = (v: number) => (v > 0 ? String(v) : null);

/**
 * P3-24b: a write connection that paused itself needs the owner, so the
 * count beside Connections says so ("1 paused") until it is reconnected;
 * otherwise it is the connected count, as before.
 */
export function connectionsCount(c: Pick<NavCounts, "connections" | "needs_reconnect">) {
  const paused = c.needs_reconnect ?? 0;
  return paused > 0 ? `${paused} paused` : n(c.connections);
}

/**
 * P4-11: tickets waiting for a person outrank everything else on Support
 * ("2 open"); otherwise the support proposals waiting for approval.
 */
export function supportCount(c: Pick<NavCounts, "support_open" | "by_module">) {
  const open = c.support_open ?? 0;
  return open > 0 ? `${open} open` : n(c.by_module.support ?? 0);
}

export const GROUPS: readonly Group[] = [
  {
    key: "approve",
    label: "To approve",
    items: [{ href: "/proposals", label: "Waiting for you", count: (c) => n(c.pending) }],
  },
  {
    key: "insights",
    label: "Insights",
    items: [
      { href: "/report", label: "Report" },
      {
        href: "/watch",
        label: "Watching",
        count: (c) => (c.watch ? `${c.watch.day}/${c.watch.of}` : null),
      },
      { href: "/progress", label: "Goals", count: (c) => n(c.goals) },
      { href: "/hours", label: "Trading hours" },
      { href: "/blindspots", label: "Blindspots" },
    ],
  },
  {
    key: "grow",
    label: "Grow",
    items: [
      { href: "/content", label: "Content", count: (c) => n(c.by_module.content ?? 0) },
      { href: "/site", label: "Website", count: (c) => n(c.by_module.site ?? 0) },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    items: [
      { href: "/customers", label: "Customers" },
      { href: "/support", label: "Support", count: supportCount },
    ],
  },
  {
    key: "business",
    label: "Your business",
    items: [
      { href: "/profile", label: "Fact sheet", count: (c) => n(c.facts) },
      { href: "/connections", label: "Connections", count: connectionsCount },
      { href: "/mode", label: "How I work" },
      { href: "/history", label: "History" },
    ],
  },
];

/** Focused views: their own masthead, no rail. */
const FOCUSED = ["/report", "/proposals"];
const LOOSE_ROUTES = ["/chat"];

const matches = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Pure: the group a path belongs to, or null when it isn't an owner screen. */
export function groupFor(path: string): Group | null {
  if (path.startsWith("/support/test")) return null; // the stand-in for an owner's own site
  return GROUPS.find((g) => g.items.some((i) => matches(path, i.href))) ?? null;
}

/** Pure: whether a path shows the rail at all. */
export function showsNav(path: string): boolean {
  if (FOCUSED.some((r) => matches(path, r))) return false;
  return groupFor(path) !== null || LOOSE_ROUTES.some((r) => matches(path, r));
}

function useCounts(path: string): NavCounts | null {
  const [counts, setCounts] = useState<NavCounts | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/nav")
      .then(async (res) => (res.ok ? ((await res.json()) as NavCounts) : null))
      .then((c) => {
        if (alive && c) setCounts(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]); // refreshed on every move, so a decision just made is reflected
  return counts;
}

// Not in the menu design, which has no way out; kept small under the foot.
function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="app-rail-signout"
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
  const counts = useCounts(path);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  if (!showsNav(path)) return <>{children}</>;

  return (
    <div className="app-frame">
      <nav className={`app-rail${open ? " open" : ""}`} aria-label="Main">
        <div className="app-rail-head">
          <Link href="/watch" className="app-rail-mark">
            Ledgerline
          </Link>
          {counts?.business && <p className="app-rail-biz">{counts.business}</p>}
          {counts?.watch && (
            <p className="app-rail-live">
              <span className="app-rail-sq" aria-hidden="true" />
              Watching · day {counts.watch.day} / {counts.watch.of}
            </p>
          )}
          <button
            type="button"
            className="app-rail-toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
        <div className="app-rail-groups">
          {GROUPS.map((g) => (
            <div key={g.key} className="app-rail-group">
              <p className="app-rail-label">{g.label}</p>
              <ul>
                {g.items.map((i) => {
                  const active = matches(path, i.href);
                  const c = counts && i.count ? i.count(counts) : null;
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={`app-rail-item${active ? " active" : ""}`}
                        aria-current={active ? "page" : undefined}
                      >
                        <span>{i.label}</span>
                        {c && <span className="app-rail-count">{c}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <Link
          href="/chat"
          className={`app-rail-ask${matches(path, "/chat") ? " active" : ""}`}
          aria-current={matches(path, "/chat") ? "page" : undefined}
        >
          <span>Ask me anything</span>
          <span aria-hidden="true">→</span>
        </Link>
        <SignOut />
      </nav>
      <div className="app-main">{children}</div>
    </div>
  );
}
