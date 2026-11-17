"use client";

// The bell (docs/DASHBOARD-OVERHAUL.md B3): what needs the owner right
// now, from the menu's own counts (components/nav/attention.ts). A count
// on the button, a short menu under it, each row a link to where the thing
// lives. It lists; it never decides anything. Before the counts have been
// read it says it is reading: "Nothing needs you." is a claim, made only
// under counted zeros.

import Link from "next/link";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import { IconButton } from "../ui/IconButton";
import { Menu } from "../ui/Menu";
import { attentionCount, attentionItems } from "./attention";

export function Notifications({ counts }: { counts: NavCounts | null }) {
  const t = useTranslations("nav.bell");
  const items = attentionItems(counts);
  const total = attentionCount(items);
  return (
    <Menu
      label={t("title")}
      trigger={(props) => (
        <IconButton
          {...props}
          className="app-bell"
          label={counts ? t("count", { count: total }) : t("title")}
          badge={total > 0 ? (total > 9 ? "9+" : total) : null}
        >
          <Bell size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      )}
    >
      <p className="ui-menu-label">{t("title")}</p>
      {!counts ? (
        <p className="ui-menu-empty">{t("reading")}</p>
      ) : items.length === 0 ? (
        <p className="ui-menu-empty">{t("empty")}</p>
      ) : (
        items.map((i) => (
          <Link key={i.key} href={i.href} role="menuitem" className="ui-menu-item">
            {t(i.key, { count: i.count })}
          </Link>
        ))
      )}
    </Menu>
  );
}
