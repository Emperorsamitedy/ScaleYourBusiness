"use client";

// The app's one navigation. The owner's redesign of 2026-11-18, after he
// used the interactive pass (docs/DASHBOARD-OVERHAUL.md, "The owner's third
// round", L3): "the nav bar's contents are a bit messy", "up to 4 max" may
// sit at the top, the rail should fold "with all tabs having their own
// icons", and "there's no clear way to go back" from the screens that
// filled the window.
//
// So: a bar across the top with the wordmark, the business, and four
// places (Home, Decisions, Insights, Grow); then search (Ctrl+K), the bell
// and the emergency stop, in the same place on every screen. Under it, on
// the left, a rail that lists the open place's screens, each with its own
// icon, and folds to icons and back. The tab strip is gone, so the top and
// the rail never say the same thing twice.
//
// 2026-11-23, the owner: "history, how it works, and all those things that
// are under the business's name has to be on the left bar", "something that
// you contract and extend", and "I don't want the drop down menu". So "Your
// business" (the fact sheet, connections, the statement, history and the
// settings) is no longer a menu behind the business's name, which is now
// only its name: it is the rail on Home, listed in full, and the last
// section of every other place's rail, with switching business and signing
// out at the rail's foot. The rail folds from a tab at the middle of its
// edge. Lex is no longer a button in the bar: its face floats at the middle
// of the right edge and opens Lex beside the page (LexPanel.tsx). On a
// phone the four places are a bar along the bottom with "More", and the
// open place's screens are one row that scrolls sideways.
//
// The menu's data did not change: GROUPS is still six groups, each screen
// in exactly one, and PLACES says which groups make a place. The queue and
// the report used to drop the frame; they keep their own columns, so the
// rail is folded on them, but the bar stays and every place is one press
// away. The landing, the interview, sign-in, the operator panel and a
// stranger's shared report never show any of it.
//
// The shell is interactive (docs/DASHBOARD-OVERHAUL.md B): the counts stay
// live, a thin cobalt bar shows while the next screen loads, "Ask Lex" opens
// the conversation as a side sheet on any screen (LexPanel.tsx), and the
// keyboard works (Shortcuts.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  LogOut,
  Menu as MenuIcon,
  Repeat,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type en from "../../messages/en.json";
import { usePathname, useRouter } from "next/navigation";
import type { NavCounts } from "../../app/api/nav/route";
import { DeepLinkMark } from "../sheet/DeepLinkMark";
import { AccessProvider } from "../auth/RoleContext";
import type { NavAccess } from "../../app/api/nav/route";
import type { SizeBand, SizeFeatureKey } from "../../lib/core/size-features";
import { showsFor } from "../../lib/core/size-features";
import { signInPath } from "../../lib/auth/return-to";
import { roleAllows } from "../../lib/auth/role-actions";
import { EmergencyStop } from "../execution/EmergencyStop";
import { useStopped } from "../execution/useStopped";
import { LexFace, lexState } from "../brand/LexFace";
import { Logo } from "../brand/Mark";
import { LanguageToggle } from "../locale/LanguageToggle";
import { Kbd } from "../ui/Kbd";
import { Sheet } from "../ui/Sheet";
import { ToastProvider, useToast } from "../ui/Toast";
import { CommandPalette, rememberScreen } from "./CommandPalette";
import type { PaletteScreen } from "./CommandPalette";
import { LexHost, inlineComposer } from "./LexPanel";
import { Notifications } from "./Notifications";
import { RouteProgress } from "./RouteProgress";
import { Shortcuts } from "./Shortcuts";
import {
  NavRefreshProvider,
  ReviewOpenerProvider,
  useLex,
  useLexBusy,
  useLexWaiting,
  useNavRefresh,
} from "./NavContext";
import type { ReviewOpener } from "./NavContext";
import { PlaceIcon, ScreenIcon } from "./nav-icons";
import { useBarFit } from "./useBarFit";
import "../../app/shell.css";

// Fetched when a decision is first opened in place from Lex or the
// conversation page: the sheet, the proposal's body and the queue's styles
// are not every screen's to carry.
const ReviewSheet = dynamic(() => import("../proposals/ReviewSheet").then((m) => m.ReviewSheet), {
  ssr: false,
});

export interface Item {
  href: string;
  /** The English label; the screen shows the catalogue's (nav.item.<feature>), which a test holds equal in English. */
  label: string;
  /** Its row in the size-feature table (lib/core/size-features.ts). */
  feature: SizeFeatureKey;
  /** One of the group's main screens, listed in the rail; the rest are tabs. */
  rail?: boolean;
  count?: (c: NavCounts, words?: CountWords) => string | null;
  /**
   * Feature 34: whether the screen exists for this business at all, read
   * from data the menu's counts carry (never an if on a business type). An
   * item with this shows only once the counts say yes.
   */
  appliesTo?: (c: NavCounts) => boolean;
  /**
   * Pages of this screen that live at an address of their own: the shadow
   * summary is opened from "What I may do" and belongs to it. A path under
   * the item's own address needs no entry here.
   */
  pages?: readonly string[];
}

export interface Group {
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
    key: "today",
    label: "Today",
    items: [{ href: "/home", label: "Home", feature: "nav.home", rail: true }],
  },
  {
    key: "approve",
    label: "To approve",
    items: [
      {
        href: "/proposals",
        label: "Waiting for you",
        feature: "nav.proposals",
        rail: true,
        count: (c) => n(c.pending),
      },
      {
        href: "/ladder",
        label: "What Lex may do",
        feature: "nav.ladder",
        rail: true,
        pages: ["/shadow"],
      },
    ],
  },
  {
    key: "insights",
    label: "Insights",
    items: [
      { href: "/report", label: "Report", feature: "nav.report", rail: true },
      {
        href: "/watch",
        label: "Watching",
        feature: "nav.watch",
        rail: true,
        count: (c) => (c.watch ? `${c.watch.day}/${c.watch.of}` : null),
      },
      {
        href: "/progress",
        label: "Goals",
        feature: "nav.goals",
        rail: true,
        count: (c) => n(c.goals),
      },
      { href: "/cash", label: "Cash flow", feature: "nav.cash", rail: true },
      { href: "/hours", label: "Trading hours", feature: "nav.hours" },
      {
        href: "/team",
        label: "Team cover",
        feature: "nav.team",
        // P5-18 (rule 28): off by default; only the owner's switch on /watch shows it.
        appliesTo: (c) => c.team === true,
      },
      { href: "/patterns", label: "Seasons & bundles", feature: "nav.patterns" },
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
      { href: "/blindspots", label: "Missing from your site", feature: "nav.blindspots" },
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
      // 2026-11-23, the owner: Grow's screens "can't really be comprehended
      // easily". The place opens on a page that says what each tool does.
      { href: "/grow", label: "All tools", feature: "nav.grow", rail: true },
      {
        href: "/content",
        label: "Posts",
        feature: "nav.content",
        rail: true,
        count: (c) => n(c.by_module.content ?? 0),
      },
      // The growth studio is this tool's second tab (2026-11-23): one place for ads and videos.
      {
        href: "/studio",
        label: "Ads and videos",
        feature: "nav.studio",
        rail: true,
        pages: ["/growth"],
      },
      {
        href: "/site",
        label: "Website",
        feature: "nav.site",
        rail: true,
        count: (c) => n(c.by_module.site ?? 0),
      },
      { href: "/simulate", label: "Test an idea", feature: "nav.simulate", rail: true },
    ],
  },
  {
    key: "customers",
    label: "Keep customers",
    items: [
      { href: "/customers", label: "Customer list", feature: "nav.customers", rail: true },
      // Idea 45: every business has reviews somewhere, so it always shows.
      { href: "/reviews", label: "Reviews", feature: "nav.reviews", rail: true },
      {
        href: "/carts",
        label: "Abandoned carts",
        feature: "nav.carts",
        rail: true,
        // Idea 47: only with a store connection that reads carts (Shopify today).
        appliesTo: (c) => c.carts === true,
      },
      {
        href: "/pipeline",
        label: "Business deals",
        feature: "nav.pipeline",
        rail: true,
        appliesTo: (c) => c.pipeline === true,
        count: (c) => n(c.by_module.pipeline ?? 0),
      },
      {
        href: "/support",
        label: "Messages",
        feature: "nav.support",
        rail: true,
        count: supportCount,
      },
    ],
  },
  {
    key: "business",
    label: "Your business",
    items: [
      {
        href: "/profile",
        label: "Fact sheet",
        feature: "nav.factsheet",
        rail: true,
        count: (c) => n(c.facts),
      },
      {
        href: "/connections",
        label: "Connections",
        feature: "nav.connections",
        rail: true,
        count: connectionsCount,
      },
      { href: "/statement", label: "Monthly statement", feature: "nav.statement", rail: true },
      { href: "/history", label: "History", feature: "nav.history", rail: true },
      { href: "/mode", label: "How I work", feature: "nav.mode" },
      { href: "/billing", label: "Plan and billing", feature: "nav.billing" },
      { href: "/settings/mandates", label: "Firms with access", feature: "nav.mandates" },
      { href: "/settings/data", label: "Erase this business", feature: "nav.erasure" },
      { href: "/partner", label: "Partner console", feature: "nav.partner" },
      {
        href: "/settings/team",
        label: "Team access",
        feature: "nav.team_access",
        // Idea 52: who can sign in — there is a team once someone has signed up.
        appliesTo: (c) => c.access?.signed_in === true,
      },
      // 2026-11-15: the weekly summary, phone alerts and module switches, moved from Watching.
      { href: "/settings/alerts", label: "Alerts and modules", feature: "nav.alerts" },
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

/** The queue and the report keep their own columns, so the rail stays folded to icons on them. */
const FOCUSED = ["/report", "/proposals"];
const LOOSE_ROUTES = ["/chat"];

const matches = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Pure: whether a path is this item's screen: its address, a page under it, or one it names. */
export function onItem(path: string, item: Pick<Item, "href" | "pages">): boolean {
  return matches(path, item.href) || (item.pages ?? []).some((p) => matches(path, p));
}

/**
 * Pure: the items the rail lists first for a group — its main screens, plus
 * the screen open now if it is one of the others. A group with no main
 * screen marked lists them all (Grow: four screens of equal weight).
 */
export function railItems(group: Group, path: string): Item[] {
  if (!group.items.some((i) => i.rail)) return group.items;
  return group.items.filter((i) => i.rail === true || onItem(path, i));
}

/** Pure: the screens a group keeps behind "more": the rest, once `railItems` are listed. */
export function railMore(group: Group, path: string): Item[] {
  const first = railItems(group, path);
  return group.items.filter((i) => !first.includes(i));
}

/** Screens that already carry the emergency stop in their own body. */
const OWN_STOP = ["/content"]; // /site gave its own up on 2026-11-23: the bar carries it

/** Pure: whether the bar across the top carries the emergency stop on this path. */
export function stripStop(path: string): boolean {
  return !OWN_STOP.some((r) => matches(path, r));
}

/** Pure: the group a path belongs to, or null when it isn't an owner screen. */
export function groupFor(path: string): Group | null {
  if (path.startsWith("/support/test")) return null; // the stand-in for an owner's own site
  return GROUPS.find((g) => g.items.some((i) => onItem(path, i))) ?? null;
}

/** Pure: the screen a group opens on — its first main screen, else its first. */
export function groupHome(group: Pick<Group, "items">): string {
  return (group.items.find((i) => i.rail) ?? group.items[0])?.href ?? "/home";
}

/** Pure: whether a path is inside the frame: the bar, and the rail where its place has one. */
export function showsNav(path: string): boolean {
  return groupFor(path) !== null || LOOSE_ROUTES.some((r) => matches(path, r));
}

/** Pure: whether the rail stays folded on this path, because the screen has columns of its own. */
export function foldsRail(path: string): boolean {
  return FOCUSED.some((r) => matches(path, r));
}

/* ── the places ── */

export type PlaceKey = "home" | "decisions" | "insights" | "grow" | "business";

export interface Place {
  key: PlaceKey;
  /** The groups of GROUPS whose screens make this place, in order. */
  groups: readonly string[];
  /** One of the four across the top; "business" is behind the business's name. */
  top: boolean;
}

/**
 * The four places across the top (the owner: "up to 4 max"), and the one
 * behind the business's name. Customers sits inside Grow.
 */
export const PLACES: readonly Place[] = [
  { key: "home", groups: ["today"], top: true },
  { key: "decisions", groups: ["approve"], top: true },
  { key: "insights", groups: ["insights"], top: true },
  { key: "grow", groups: ["grow", "customers"], top: true },
  { key: "business", groups: ["business"], top: false },
];

/** Pure: the place a path belongs to; the conversation page belongs to Home. */
export function placeFor(path: string): PlaceKey | null {
  if (LOOSE_ROUTES.some((r) => matches(path, r))) return "home";
  const g = groupFor(path);
  if (!g) return null;
  return PLACES.find((p) => p.groups.includes(g.key))?.key ?? null;
}

/** Pure: a place's groups as this business sees them, in the place's own order. */
export function placeGroups(place: PlaceKey, groups: readonly Group[]): Group[] {
  const p = PLACES.find((x) => x.key === place);
  return p ? p.groups.flatMap((k) => groups.filter((g) => g.key === k)) : [];
}

/** Pure: the screen a place opens on — its first group's first main screen. */
export function placeHome(place: PlaceKey, groups: readonly Group[]): string {
  const first = placeGroups(place, groups)[0];
  return first ? groupHome(first) : "/home";
}

/**
 * Pure: the groups the rail lists on a place (2026-11-23). Home's one screen
 * needs no list of its own, so its rail is "Your business"; every other
 * place lists its own screens, then "Your business" as its last section.
 */
export function railGroupsFor(place: PlaceKey, groups: readonly Group[]): Group[] {
  const business = placeGroups("business", groups);
  if (place === "home" || place === "business") return business;
  return [...placeGroups(place, groups), ...business];
}

/** Pure: whether a place has a rail at all: only with two or more screens on it. */
export function placeHasRail(place: PlaceKey, groups: readonly Group[]): boolean {
  return railGroupsFor(place, groups).reduce((sum, g) => sum + g.items.length, 0) > 1;
}

/** How often the menu's counts are read again while the tab is visible. */
const COUNTS_EVERY_MS = 60_000;
/** A window that regains focus reads again, but not more often than this. */
const FOCUS_GAP_MS = 10_000;

/**
 * The menu's counts. Read on every move (so a decision just made is
 * reflected), and, on an owner screen (`live`), again every minute while
 * the tab is visible, when the window regains focus, and whenever a screen
 * asks through `useNavRefresh()` (docs/DASHBOARD-OVERHAUL.md B4).
 */
function useCounts(path: string, live: boolean): { counts: NavCounts | null; refresh: () => void } {
  const [counts, setCounts] = useState<NavCounts | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // A stranger's page (a shared report, idea 51) never asks for the owner's counts.
  const shared = path.startsWith("/shared/");

  useEffect(() => {
    if (shared) return;
    let alive = true;
    void fetch("/api/nav", { cache: "no-store" })
      .then(async (res) => {
        // No session and no interview under way: there is nothing of anyone's
        // to show on an owner screen. The visitor signs in and comes back
        // here (Home has always done this on the server; every other screen
        // drew the frame around nothing). A failed read is not a 401 and
        // sends nobody anywhere.
        if (res.status === 401 && live && alive) {
          window.location.replace(signInPath(path));
          return null;
        }
        return res.ok ? ((await res.json()) as NavCounts) : null;
      })
      .then((c) => {
        if (alive && c) setCounts(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, tick, shared, live]);

  useEffect(() => {
    if (!live || shared) return;
    let last = Date.now();
    const again = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      refresh();
    };
    const every = window.setInterval(again, COUNTS_EVERY_MS);
    const onFocus = () => {
      if (Date.now() - last >= FOCUS_GAP_MS) again();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [live, shared, refresh]);

  return { counts, refresh };
}

/** Where the rail's fold is remembered, per browser. */
const FOLD_KEY = "scalex:rail";

/**
 * Whether the owner folded the rail to icons. Remembered in this browser;
 * storage can be missing or blocked, and then the rail is simply open.
 */
function useRailFold(): [boolean, () => void] {
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try {
      setFolded(window.localStorage.getItem(FOLD_KEY) === "folded");
    } catch {
      // a private window, or storage blocked: the rail stays open
    }
  }, []);
  const toggle = useCallback(() => {
    setFolded((was) => {
      try {
        window.localStorage.setItem(FOLD_KEY, was ? "open" : "folded");
      } catch {
        // not remembered, still folded for this visit
      }
      return !was;
    });
  }, []);
  return [folded, toggle];
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

type NavT = ReturnType<typeof useTranslations<"nav">>;

/** A place's name: Home is the Home screen's own word, the rest are the groups'. */
function placeName(t: NavT, place: PlaceKey): string {
  if (place === "home") return t("item.home");
  if (place === "decisions") return t("place.decisions");
  if (place === "insights") return t("group.insights");
  if (place === "grow") return t("group.grow");
  return t("group.business");
}

function SignOut({ className, role }: { className: string; role?: "menuitem" | undefined }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      role={role}
      className={className}
      // Its name on hover and on focus when the rail is folded to icons.
      data-tip={t("signOut")}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        router.push("/login");
      }}
    >
      <LogOut size={17} strokeWidth={1.75} aria-hidden="true" />
      <span>{busy ? t("signingOut") : t("signOut")}</span>
    </button>
  );
}

/**
 * What sits behind the business's name: the screens of "Your business",
 * the other businesses this person belongs to (idea 52, plain form posts to
 * /api/auth/switch, names only), who they are here, and the way out. One
 * list, drawn as a menu on a desk and as a sheet on a phone.
 */
function BusinessLinks({
  as,
  group,
  path,
  counts,
  words,
  access,
}: {
  as: "menu" | "sheet";
  group: Group | null;
  path: string;
  counts: NavCounts | null;
  words: CountWords;
  access: NavAccess | null;
}) {
  const t = useTranslations();
  const item = as === "menu" ? "ui-menu-item sx-menu-item" : "sx-sheet-item";
  const role = as === "menu" ? ("menuitem" as const) : undefined;
  const others =
    access && access.businesses.length > 1 ? access.businesses.filter((b) => !b.current) : [];
  const who = roleKey(access);
  return (
    <>
      {group?.items.map((i) => {
        const active = onItem(path, i);
        const c = counts && i.count ? i.count(counts, words) : null;
        return (
          <Link
            key={i.href}
            href={i.href}
            role={role}
            className={item}
            aria-current={active ? "page" : undefined}
          >
            <ScreenIcon href={i.href} size={17} />
            <span className="sx-item-label">{t(`nav.item.${itemKey(i)}`)}</span>
            {c && <span className="sx-item-count">{c}</span>}
          </Link>
        );
      })}
      {others.length > 0 && (
        <form method="post" action="/api/auth/switch" className="sx-switch">
          <p className="ui-menu-label">{t("nav.switchBusiness")}</p>
          {others.map((b) => (
            <button
              key={b.account_id}
              type="submit"
              role={role}
              name="account_id"
              value={b.account_id}
              className={item}
            >
              <Repeat size={17} strokeWidth={1.75} aria-hidden="true" />
              <span className="sx-item-label">{b.name ?? t("common.businessUnnamed")}</span>
            </button>
          ))}
        </form>
      )}
      <div className="sx-menu-foot">
        {who && <p className="sx-who">{t(`nav.role.${who}`)}</p>}
        <SignOut className={item} role={role} />
      </div>
    </>
  );
}

/**
 * Lex's face afloat at the middle of the right edge (above the bar on a
 * phone), wherever the page has no composer of its own: where Lex is always
 * found (the owner, 2026-11-23: "the icon has to be floating ... on the
 * right"). It gives way to Lex beside the page, which it opens (app/shell.css).
 */
function LexFab({ path, stopped }: { path: string; stopped: boolean | null }) {
  const t = useTranslations("nav");
  const lex = useLex();
  const busy = useLexBusy();
  const waiting = useLexWaiting();
  if (inlineComposer(path) !== null) return null;
  return (
    <button
      type="button"
      className="sx-fab"
      aria-label={waiting ? t("answered") : t("ask")}
      title={waiting ? t("answered") : undefined}
      onClick={() => lex.open()}
    >
      <LexFace size={46} state={lexState({ stopped: stopped === true, working: busy })} />
      {/* An answer that came while Lex was closed (components/nav/LexPanel arrivedUnseen). */}
      {waiting && <span className="sx-answer" aria-hidden="true" />}
    </button>
  );
}

/**
 * A decision opened in place from anywhere in the frame: Lex's pop-up and the
 * conversation page, where "Open" used to leave for the decision's own page
 * (the review's round 1). One sheet for the whole frame, read from the server
 * only when it is first wanted. Home keeps its own, which lives in its
 * address. The answer is recorded by the sheet through the queue's own
 * endpoint (rule 12); this only closes it, says so and reads the counts again.
 */
function FrameReview({
  path,
  stopped,
  children,
}: {
  path: string;
  stopped: boolean | null;
  children: ReactNode;
}) {
  const t = useTranslations("home");
  const refresh = useNavRefresh();
  const toast = useToast();
  const [open, setOpen] = useState<{ id: string; after: (() => void) | null } | null>(null);
  const opener = useCallback<ReviewOpener>(
    (id, after) => setOpen({ id, after: after ?? null }),
    [],
  );
  // A decision opened over one page is not carried to the next.
  useEffect(() => setOpen(null), [path]);
  return (
    <ReviewOpenerProvider value={opener}>
      {children}
      {open && (
        <ReviewSheet
          id={open.id}
          halted={stopped === true}
          returnTo={path}
          onClose={() => setOpen(null)}
          onAnswered={(_id, answer) => {
            const after = open.after;
            setOpen(null);
            toast(answer === "approve" ? t("toast.approved") : t("toast.declined"));
            refresh();
            after?.();
          }}
        />
      )}
    </ReviewOpenerProvider>
  );
}

/** "Ctrl" or, on a Mac, "⌘": known only in the browser, so the server says Ctrl. */
function ModKey() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>;
}

/**
 * The rail: the open place's screens, each with its icon. A group's main
 * screens come first; the rest wait behind "n more". Folded, it is a column
 * of icons whose names show on hover and on focus.
 */
function Rail({
  title,
  groups,
  full,
  path,
  counts,
  words,
  access,
  folded,
  locked,
  onFold,
}: {
  /** The rail's name: the place's, or "Your business" on Home. */
  title: string;
  groups: Group[];
  /** The groups listed in full, with nothing held behind "more". */
  full: readonly string[];
  path: string;
  counts: NavCounts | null;
  words: CountWords;
  access: NavAccess | null;
  folded: boolean;
  /** The screen keeps the rail folded (the queue, the report): no button to unfold it. */
  locked: boolean;
  onFold: () => void;
}) {
  const t = useTranslations("nav");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // On a phone the rail is one row that scrolls sideways: the open screen is brought into view.
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = rail.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const at = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!at) return;
    const a = at.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    nav.scrollLeft += a.left - n.left - (n.width - a.width) / 2;
  }, [path]);
  const row = (i: Item) => {
    const active = onItem(path, i);
    const c = counts && i.count ? i.count(counts, words) : null;
    const label = t(`item.${itemKey(i)}`);
    return (
      <li key={i.href}>
        <Link
          href={i.href}
          className="sx-item"
          aria-current={active ? "page" : undefined}
          data-tip={c ? `${label} · ${c}` : label}
        >
          <ScreenIcon href={i.href} />
          <span className="sx-item-label">{label}</span>
          {c && <span className="sx-item-count">{c}</span>}
        </Link>
      </li>
    );
  };
  const hasBusiness = groups.some((g) => g.key === "business");
  // A section is named when the rail holds more than one; the place's own
  // first section is not, when it is the place's only one (its name is the rail's).
  const own = groups.filter((g) => g.key !== "business").length;
  const named = (i: number) => groups.length > 1 && (i > 0 || own > 1);
  return (
    <div className="sx-rail-wrap">
      <nav className="sx-rail" aria-label={title} ref={rail}>
        <div className="sx-rail-head">
          <span className="sx-rail-title">{title}</span>
        </div>
        {groups.map((g, i) => {
          const listed = full.includes(g.key) ? g.items : railItems(g, path);
          const more = full.includes(g.key) ? [] : railMore(g, path);
          const shown = open[g.key] === true;
          return (
            <div key={g.key} className="sx-rail-group" data-group={g.key}>
              {named(i) && (
                <p className="sx-rail-sec">
                  {g.key === "grow" ? t("section.marketing") : t(`group.${g.key as NavGroupKey}`)}
                </p>
              )}
              <ul>
                {listed.map(row)}
                {more.length > 0 && (
                  <>
                    <li className="sx-more-row">
                      <button
                        type="button"
                        className="sx-item sx-more"
                        aria-expanded={shown}
                        data-tip={shown ? t("rail.fewer") : t("rail.more", { count: more.length })}
                        onClick={() => setOpen((o) => ({ ...o, [g.key]: !shown }))}
                      >
                        <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" />
                        <span className="sx-item-label">
                          {shown ? t("rail.fewer") : t("rail.more", { count: more.length })}
                        </span>
                      </button>
                    </li>
                    {/* On a phone the row scrolls sideways and nothing is held back. */}
                    <li className={shown ? "sx-more-items open" : "sx-more-items"}>
                      <ul>{more.map(row)}</ul>
                    </li>
                  </>
                )}
              </ul>
            </div>
          );
        })}
        {hasBusiness && <RailFoot access={access} />}
      </nav>
      {/* The fold sits on the rail's edge, at its middle, outside the part that scrolls. */}
      {!locked && (
        <button
          type="button"
          className="sx-fold"
          aria-pressed={folded}
          aria-label={folded ? t("rail.unfold") : t("rail.fold")}
          title={folded ? t("rail.unfold") : t("rail.fold")}
          onClick={onFold}
        >
          {folded ? (
            <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronLeft size={15} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * The rail's foot, under "Your business": the other businesses this person
 * belongs to (idea 52, plain form posts to /api/auth/switch, names only),
 * who they are here, and the way out. What used to close the business menu.
 */
function RailFoot({ access }: { access: NavAccess | null }) {
  const t = useTranslations();
  const others =
    access && access.businesses.length > 1 ? access.businesses.filter((b) => !b.current) : [];
  const who = roleKey(access);
  return (
    <div className="sx-rail-foot">
      {others.length > 0 && (
        <form method="post" action="/api/auth/switch" className="sx-switch">
          <p className="sx-rail-sec">{t("nav.switchBusiness")}</p>
          <ul>
            {others.map((b) => {
              const name = b.name ?? t("common.businessUnnamed");
              return (
                <li key={b.account_id}>
                  <button
                    type="submit"
                    name="account_id"
                    value={b.account_id}
                    className="sx-item"
                    data-tip={name}
                  >
                    <Repeat size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-item-label">{name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </form>
      )}
      {who && <p className="sx-who sx-rail-sec">{t(`nav.role.${who}`)}</p>}
      <SignOut className="sx-item sx-signout" />
    </div>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const words: CountWords = (kind, count) => t(`count.${kind}`, { count });
  const path = usePathname() ?? "/";
  const framed = showsNav(path);
  const { counts, refresh } = useCounts(path, framed);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [path]);
  const [foldedByOwner, toggleFold] = useRailFold();
  const stopped = useStopped(framed);
  // The bar folds until what it holds fits, in any language (useBarFit.ts).
  const bar = useRef<HTMLElement>(null);
  useBarFit(bar, framed);
  // The palette's "Recent": the owner screens visited, latest first.
  useEffect(() => {
    if (groupFor(path)) rememberScreen(path);
  }, [path]);
  const access = counts?.access ?? null;
  const groups = visibleGroups(counts?.size_band?.band ?? null, counts);
  const screens: PaletteScreen[] = groups.flatMap((g) =>
    g.items.map((i) => ({
      href: i.href,
      label: t(`item.${itemKey(i)}`),
      group: t(`group.${g.key as NavGroupKey}`),
      keywords: `${i.label} ${g.label}`,
    })),
  );
  if (!framed) {
    return (
      <AccessProvider value={access}>
        <DeepLinkMark />
        {children}
      </AccessProvider>
    );
  }

  const place = placeFor(path);
  const business = placeGroups("business", groups)[0] ?? null;
  const railGroups = place ? railGroupsFor(place, groups) : [];
  const hasRail = railGroups.reduce((sum, g) => sum + g.items.length, 0) > 1;
  const locked = foldsRail(path);
  const folded = locked || foldedByOwner;
  const name = counts?.business ?? t("group.business");
  const pending = counts && counts.pending > 0 ? String(counts.pending) : null;
  const frame = [
    "app-frame",
    "sx",
    hasRail ? "has-rail" : "",
    hasRail && folded ? "rail-folded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ToastProvider>
      <NavRefreshProvider value={refresh}>
        <AccessProvider value={access}>
          <FrameReview path={path} stopped={stopped}>
            <LexHost
              path={path}
              business={counts?.business ?? null}
              facts={counts ? counts.facts : null}
            >
              <div className={frame}>
                <header className="sx-top" ref={bar}>
                  <Link href="/home" className="sx-logo" aria-label="ScaleX">
                    <Logo onDark />
                  </Link>
                  <span className="sx-sep" aria-hidden="true" />
                  {/* Only the name: what sat behind it is on the rail (2026-11-23). */}
                  <span className="sx-biz">
                    <span className="sx-biz-name">{name}</span>
                  </span>
                  <nav className="sx-places" aria-label={t("label")}>
                    {PLACES.filter((p) => p.top).map((p) => (
                      <Link
                        key={p.key}
                        href={placeHome(p.key, groups)}
                        className="sx-place"
                        title={placeName(t, p.key)}
                        aria-current={place === p.key ? "page" : undefined}
                      >
                        <PlaceIcon place={p.key} />
                        <span>{placeName(t, p.key)}</span>
                        {p.key === "decisions" && pending && (
                          <span className="sx-count">{pending}</span>
                        )}
                      </Link>
                    ))}
                  </nav>
                  <span className="sx-gap" />
                  <button
                    type="button"
                    className="sx-search"
                    aria-haspopup="dialog"
                    aria-expanded={palette}
                    aria-label={t("search")}
                    title={t("search")}
                    onClick={() => setPalette(true)}
                  >
                    <Search size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-search-word">{t("search")}</span>
                    <span className="sx-search-keys" aria-hidden="true">
                      <ModKey />
                      <Kbd>K</Kbd>
                    </span>
                  </button>
                  {/* The owner, 2026-11-20: a button in the top right corner between Hungarian and English. */}
                  <LanguageToggle className="sx-lang" />
                  <Notifications counts={counts} />
                  {stripStop(path) && <EmergencyStop variant="masthead" />}
                </header>
                <RouteProgress path={path} />
                <div className="sx-body">
                  {hasRail && place && (
                    <Rail
                      title={place === "home" ? t("group.business") : placeName(t, place)}
                      groups={railGroups}
                      full={place === "home" || place === "business" ? ["business"] : []}
                      path={path}
                      counts={counts}
                      words={words}
                      access={access}
                      folded={folded}
                      locked={locked}
                      onFold={toggleFold}
                    />
                  )}
                  <div className="app-main">
                    <DeepLinkMark />
                    {children}
                  </div>
                </div>
                <nav className="sx-bar" aria-label={t("dock")}>
                  {PLACES.filter((p) => p.top).map((p) => (
                    <Link
                      key={p.key}
                      href={placeHome(p.key, groups)}
                      className="sx-bar-item"
                      aria-current={place === p.key ? "page" : undefined}
                    >
                      <PlaceIcon place={p.key} size={21} />
                      <span>{placeName(t, p.key)}</span>
                      {p.key === "decisions" && pending && (
                        <span className="sx-bar-count">{pending}</span>
                      )}
                    </Link>
                  ))}
                  <button
                    type="button"
                    className="sx-bar-item"
                    aria-haspopup="dialog"
                    aria-expanded={more}
                    aria-current={place === "business" ? "page" : undefined}
                    onClick={() => setMore(true)}
                  >
                    <MenuIcon size={21} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t("more")}</span>
                  </button>
                </nav>
                <LexFab path={path} stopped={stopped} />
              </div>
              <Sheet
                open={more}
                onClose={() => setMore(false)}
                title={name}
                kicker={t("group.business")}
              >
                <div className="sx-sheet-list">
                  <BusinessLinks
                    as="sheet"
                    group={business}
                    path={path}
                    counts={counts}
                    words={words}
                    access={access}
                  />
                </div>
              </Sheet>
              <CommandPalette
                open={palette}
                onClose={() => setPalette(false)}
                path={path}
                screens={screens}
                access={access}
                onHelp={() => setHelp(true)}
              />
              <Shortcuts onPalette={() => setPalette((o) => !o)} help={help} onHelp={setHelp} />
            </LexHost>
          </FrameReview>
        </AccessProvider>
      </NavRefreshProvider>
    </ToastProvider>
  );
}
