// "Ads and videos" is one tool with two tabs (2026-11-23): the creative
// studio's ideas from the trade (/studio) and the growth studio's voice,
// photos and briefs (/growth), which used to sit apart under two names in
// two places. Each tab keeps its own address and does what it did.

import Link from "next/link";
import { useTranslations } from "next-intl";
import "../../app/grow.css";

export function AdsTabs({ at }: { at: "ideas" | "yours" }) {
  const t = useTranslations("studio.tabs");
  return (
    <nav className="gw-tabs" aria-label={t("label")}>
      <Link href="/studio" aria-current={at === "ideas" ? "page" : undefined}>
        {t("ideas")}
      </Link>
      <Link href="/growth" aria-current={at === "yours" ? "page" : undefined}>
        {t("yours")}
      </Link>
    </nav>
  );
}
