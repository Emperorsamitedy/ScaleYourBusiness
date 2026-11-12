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
import { useTranslations } from "next-intl";
import type en from "../../messages/en.json";
import { usePathname, useRouter } from "next/navigation";
import type { NavCounts } from "../../app/api/nav/route";
import { DeepLinkMark } from "../sheet/DeepLinkMark";
import { AccessProvider } from "../auth/RoleContext";
import type { NavAccess } from "../../app/api/nav/route";
import type { SizeBand, SizeFeatureKey } from "../../lib/core/size-features";
import { showsFor } from "../../lib/core/size-features";
import { roleAllows } from "../../lib/auth/role-actions";

interface Item {
  href: string;
  /** The English label; the screen shows the catalogue's (nav.item.<feature>), which a test holds equal in English. */
  label: string;
  /** Its row in the size-feature table (lib/core/size-features.ts). */
  feature: SizeFeatureKey;
  count?: (c: NavCounts, words?: CountWords) => string | null;
  /**
   * Feature 34: whether the screen exists for this business at all, read
   * from data the menu's counts carry (never an if on a business type). An
   * item with this shows only once the counts say yes.
   */
  appliesTo?: (c: NavCounts) => boolean;
}

interface Group {
  key: string;
  label: string;
  items: Item[];
}

const n = (v: number) => (v > 0 ? String(v) : null);

/** A count said in words — "1 paused", "2 open" — in English unless a translator is given. */
export type CountWords = (kind: "paused" | "open", count: number) => string;
const ENGLISH_COUNT: CountWords = (kind, count) => `${count} ${kind}`;

/**
 * P3-24b: a write connection that paused itself needs the owner, so the
 * count beside Connections says so ("1 paused") until it is reconnected;
 * otherwise it is the connected count, as before.
 */
export function connectionsCount(
  c: Pick<NavCounts, "connections" | "needs_reconnect">,
  words: CountWords = ENGLISH_COUNT,
) {
  const paused = c.needs_reconnect ?? 0;
  return paused > 0 ? words("paused", paused) : n(c.connections);
}

/**
 * P4-11: tickets waiting for a person outrank everything else on Support
 * ("2 open"); otherwise the support proposals waiting for approval.
 */
export function supportCount(
  c: Pick<NavCounts, "support_open" | "by_module">,
  words: CountWords = ENGLISH_COUNT,
) {
  const open = c.support_open ?? 0;
  return open > 0 ? words("open", open) : n(c.by_module.support ?? 0);
}

export const GROUPS: readonly Group[] = [
  {
    key: "approve",
    label: "To approve",
    items: [
      {
        href: "/proposals",
        label: "Waiting for you",
        feature: "nav.proposals",
        count: (c) => n(c.pending),
      },
    ],
  },
  {
    key: "insights",
    label: "Insights",
    items: [
      { href: "/report", label: "Report", feature: "nav.report" },
      {
        href: "/watch",
        label: "Watching",
        feature: "nav.watch",
        count: (c) => (c.watch ? `${c.watch.day}/${c.watch.of}` : null),
      },
      { href: "/progress", label: "Goals", feature: "nav.goals", count: (c) => n(c.goals) },
      { href: "/hours", label: "Trading hours", feature: "nav.hours" },
      {
        href: "/team",
        label: "Team cover",
        feature: "nav.team",
        // P5-18 (rule 28): off by default; only the owner's switch on /watch shows it.
        appliesTo: (c) => c.team === true,
      },
      { href: "/patterns", label: "Seasons & bundles", feature: "nav.patterns" },
      { href: "/cash", label: "Cash flow", feature: "nav.cash" },
      // P6-05: payments SYB prepares and the owner pays in their own bank.
      // Owner only (least privilege, the owner's decision of 2026-11-09): a
      // manager or a viewer never sees it, as /api/payments refuses them.
      {
        href: "/payments",
        label: "Payments",
        feature: "nav.payments",
        appliesTo: (c) => c.access !== undefined && roleAllows(c.access.role, "payments.read"),
      },
      {
        href: "/stock",
        label: "Stock",
        feature: "nav.stock",
        appliesTo: (c) => c.stock === true,
        count: (c) => n(c.by_module.stock ?? 0),
      },
      { href: "/blindspots", label: "Blindspots", feature: "nav.blindspots" },
      { href: "/competitors", label: "Competitors", feature: "nav.competitors" },
      {
        href: "/benchmarks",
        label: "Similar businesses",
        feature: "nav.benchmarks",
      },
    ],
  },
  {
    key: "grow",
    label: "Grow",
    items: [
      {
        href: "/content",
        label: "Content",
        feature: "nav.content",
        count: (c) => n(c.by_module.content ?? 0),
      },
      { href: "/studio", label: "Creative studio", feature: "nav.studio" },
      {
        href: "/site",
        label: "Website",
        feature: "nav.site",
        count: (c) => n(c.by_module.site ?? 0),
      },
      { href: "/simulate", label: "Campaign simulator", feature: "nav.simulate" },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    items: [
      { href: "/customers", label: "Customers", feature: "nav.customers" },
      // Idea 45: every business has reviews somewhere, so it always shows.
      { href: "/reviews", label: "Reviews", feature: "nav.reviews" },
      {
        href: "/carts",
        label: "Abandoned carts",
        feature: "nav.carts",
        // Idea 47: only with a store connection that reads carts (Shopify today).
        appliesTo: (c) => c.carts === true,
      },
      {
        href: "/pipeline",
        label: "Pipeline",
        feature: "nav.pipeline",
        appliesTo: (c) => c.pipeline === true,
        count: (c) => n(c.by_module.pipeline ?? 0),
      },
      { href: "/support", label: "Support", feature: "nav.support", count: supportCount },
    ],
  },
  {
    key: "business",
    label: "Your business",
    items: [
      { href: "/profile", label: "Fact sheet", feature: "nav.factsheet", count: (c) => n(c.facts) },
      {
        href: "/connections",
        label: "Connections",
        feature: "nav.connections",
        count: connectionsCount,
      },
      { href: "/mode", label: "How I work", feature: "nav.mode" },
      { href: "/ladder", label: "What I may do", feature: "nav.ladder" },
      { href: "/history", label: "History", feature: "nav.history" },
      {
        href: "/settings/team",
        label: "Team access",
        feature: "nav.team_access",
        // Idea 52: who can sign in — there is a team once someone has signed up.
        appliesTo: (c) => c.access?.signed_in === true,
      },
      // L-1: the language you read, and the business's language and currency.
      { href: "/settings/language", label: "Language and currency", feature: "nav.language" },
    ],
  },
];

/**
 * Pure: the groups as a business of this size sees them — items the
 * size-feature table hides are left out, and a group left empty drops.
 * A null band (nothing stated, no headcount) shows every item. With
 * `counts` given, an item that exists only for some businesses (appliesTo)
 * shows when they say it applies; null counts (still loading) hide it.
 */
export function visibleGroups(band: SizeBand | null, counts?: NavCounts | null): Group[] {
  const applies = (i: Item) =>
    i.appliesTo === undefined || counts === undefined || (counts !== null && i.appliesTo(counts));
  return GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => showsFor(i.feature, band) && applies(i)),
  })).filter((g) => g.items.length > 0);
}

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
    // A stranger's page (a shared report, idea 51) never asks for the owner's counts.
    if (path.startsWith("/shared/")) return;
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

/**
 * Idea 52: the other businesses this person belongs to, as plain form posts
 * to /api/auth/switch — shown only when there are two or more. Names only.
 */
export function Switcher({ access }: { access: NavAccess | null | undefined }) {
  const t = useTranslations();
  const others = access?.businesses.filter((b) => !b.current) ?? [];
  if (!access || access.businesses.length < 2) return null;
  return (
    <details className="app-rail-switch">
      <summary>{t("nav.switchBusiness")}</summary>
      <form method="post" action="/api/auth/switch">
        {others.map((b) => (
          <button key={b.account_id} type="submit" name="account_id" value={b.account_id}>
            {b.name ?? t("common.businessUnnamed")}
          </button>
        ))}
      </form>
    </details>
  );
}

/** The catalogue key of a menu item's label: its size-feature key without "nav.". */
export type NavItemKey = keyof (typeof en)["nav"]["item"];
export type NavGroupKey = keyof (typeof en)["nav"]["group"];
export const itemKey = (i: Pick<Item, "feature">): NavItemKey => i.feature.slice(4) as NavItemKey;

/** Pure: which of the role lines applies — none before sign-up. */
export function roleKey(access: NavAccess | null | undefined): NavAccess["role"] | null {
  if (!access || !access.signed_in) return null;
  return access.role;
}

const ROLE_LINE: Record<NavAccess["role"], string> = {
  owner: "You're an owner here",
  manager: "You're a manager here",
  viewer: "You're a viewer here: you can read, and press stop",
};

/** Pure: the quiet line under the menu saying who you are here, in English (nav.role.* on screen). */
export function roleLine(access: NavAccess | null | undefined): string | null {
  const key = roleKey(access);
  return key === null ? null : ROLE_LINE[key];
}

// Not in the menu design, which has no way out; kept small under the foot.
function SignOut() {
  const t = useTranslations("nav");
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
      {busy ? t("signingOut") : t("signOut")}
    </button>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const words: CountWords = (kind, count) => t(`count.${kind}`, { count });
  const path = usePathname() ?? "/";
  const counts = useCounts(path);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const access = counts?.access ?? null;
  const role = roleKey(access);
  if (!showsNav(path)) {
    return (
      <AccessProvider value={access}>
        <DeepLinkMark />
        {children}
      </AccessProvider>
    );
  }

  return (
    <div className="app-frame">
      <nav className={`app-rail${open ? " open" : ""}`} aria-label={t("label")}>
        <div className="app-rail-head">
          <Link href="/watch" className="app-rail-mark">
            SYB
          </Link>
          {counts?.business && <p className="app-rail-biz">{counts.business}</p>}
          <Switcher access={access} />
          {counts?.watch && (
            <p className="app-rail-live">
              <span className="app-rail-sq" aria-hidden="true" />
              {t("watching", { day: counts.watch.day, of: counts.watch.of })}
            </p>
          )}
          <button
            type="button"
            className="app-rail-toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t("close") : t("menu")}
          </button>
        </div>
        <div className="app-rail-groups">
          {visibleGroups(counts?.size_band?.band ?? null, counts).map((g) => (
            <div key={g.key} className="app-rail-group">
              <p className="app-rail-label">{t(`group.${g.key as NavGroupKey}`)}</p>
              <ul>
                {g.items.map((i) => {
                  const active = matches(path, i.href);
                  const c = counts && i.count ? i.count(counts, words) : null;
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={`app-rail-item${active ? " active" : ""}`}
                        aria-current={active ? "page" : undefined}
                      >
                        <span>{t(`item.${itemKey(i)}`)}</span>
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
          <span>{t("ask")}</span>
          <span aria-hidden="true">→</span>
        </Link>
        {role && <p className="app-rail-who">{t(`role.${role}`)}</p>}
        <SignOut />
      </nav>
      <div className="app-main">
        <AccessProvider value={access}>
          <DeepLinkMark />
          {children}
        </AccessProvider>
      </div>
    </div>
  );
}
