// An icon for every place and every screen of the menu (the owner,
// 2026-11-18: "all tabs having their own icons"). One table, keyed by the
// screen's address, so a screen added to GROUPS without an icon fails the
// test beside it (nav-icons.test.ts) instead of shipping a blank square.
// Lucide, 1.75px stroke, in the ink of the surface (ux-spec §2).

import {
  Banknote,
  BellRing,
  Binoculars,
  BookOpen,
  Building2,
  CalendarRange,
  ChartColumn,
  ChartNoAxesColumn,
  Clapperboard,
  Clock,
  CreditCard,
  Eye,
  FileText,
  Globe,
  Handshake,
  Headset,
  History,
  House,
  Inbox,
  Languages,
  Package,
  PenLine,
  Plug,
  Radar,
  Receipt,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Sprout,
  SquareCheck,
  Star,
  Target,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  Workflow,
  LayoutGrid,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** The icon of each screen, by its address in GROUPS. */
export const SCREEN_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/home": House,
  "/proposals": Inbox,
  "/ladder": ShieldCheck,
  "/report": FileText,
  "/watch": Eye,
  "/progress": Target,
  "/cash": Wallet,
  "/hours": Clock,
  "/team": UsersRound,
  "/patterns": CalendarRange,
  "/payments": Banknote,
  "/stock": Package,
  "/blindspots": Radar,
  "/competitors": Binoculars,
  "/benchmarks": ChartColumn,
  "/grow": LayoutGrid,
  "/content": PenLine,
  "/studio": Clapperboard,
  "/site": Globe,
  "/simulate": SlidersHorizontal,
  "/customers": Users,
  "/reviews": Star,
  "/carts": ShoppingCart,
  "/pipeline": Workflow,
  "/support": Headset,
  "/profile": BookOpen,
  "/connections": Plug,
  "/statement": Receipt,
  "/history": History,
  "/mode": Settings2,
  "/growth": Sprout,
  "/billing": CreditCard,
  "/settings/mandates": Building2,
  "/settings/data": Trash2,
  "/partner": Handshake,
  "/settings/team": UserPlus,
  "/settings/alerts": BellRing,
  "/settings/language": Languages,
};

/** The icon of each of the four places across the top. */
export const PLACE_ICONS: Readonly<Record<string, LucideIcon>> = {
  home: House,
  decisions: SquareCheck,
  insights: ChartNoAxesColumn,
  grow: TrendingUp,
};

export function ScreenIcon({ href, size = 18 }: { href: string; size?: number }) {
  const Icon = SCREEN_ICONS[href];
  return Icon ? <Icon size={size} strokeWidth={1.75} aria-hidden="true" /> : null;
}

export function PlaceIcon({ place, size = 16 }: { place: string; size?: number }) {
  const Icon = PLACE_ICONS[place];
  return Icon ? <Icon size={size} strokeWidth={1.75} aria-hidden="true" /> : null;
}
