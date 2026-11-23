"use client";

// /grow — Grow's front page (2026-11-23, the owner: "so many pages ... that
// don't really have any clarity to simple users", Grow first). Pressing Grow
// opens here: every tool this business sees, in Grow's two halves (bring in
// customers, keep them), each as a card saying what it does in one line, the
// one counted figure it has where it has one, and the button to press next.
// Which tools show is the menu's own rule (AppFrame visibleGroups), so the
// front page and the rail never disagree.

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import { dataOf } from "../home/home-model";
import { useRead } from "../home/useRead";
import { itemKey, visibleGroups } from "../nav/AppFrame";
import { ScreenIcon } from "../nav/nav-icons";
import { PageHead } from "../sheet/PageHead";
import { Skeleton } from "../ui/Skeleton";
import { GROW_TOOLS, TOOL_HALF, TOOL_HREF, toolStatus } from "./grow-tools";
import type { GrowHalf, GrowTool } from "./grow-tools";
import "../../app/grow.css";

/** A tool's second way in, where it has one: a price to test, beside a campaign. */
const SECOND: Partial<Record<GrowTool, string>> = { test: "/simulate?tab=pricing" };

export function GrowScreen() {
  const t = useTranslations("grow");
  const nav = useTranslations("nav");
  const [read] = useRead<NavCounts>("/api/nav", { every: 60_000 });
  const counts = dataOf(read);
  const items = visibleGroups(counts?.size_band?.band ?? null, counts).flatMap((g) => g.items);
  const shown = GROW_TOOLS.flatMap((tool) => {
    const item = items.find((i) => i.href === TOOL_HREF[tool]);
    return item ? [{ tool, item }] : [];
  });

  const half = (h: GrowHalf) => (
    <section className="gw-half" aria-labelledby={`gw-${h}`}>
      <h2 className="gw-half-title" id={`gw-${h}`}>
        {t(`half.${h}`)}
      </h2>
      <div className="gw-grid">
        {shown
          .filter(({ tool }) => TOOL_HALF[tool] === h)
          .map(({ tool, item }) => {
            const status = toolStatus(tool, counts);
            const second = SECOND[tool];
            return (
              <article key={tool} className="gw-card">
                <ScreenIcon href={item.href} size={22} />
                <h3 className="gw-name">{nav(`item.${itemKey(item)}`)}</h3>
                <p className="gw-what">{t(`tools.${tool}.line`)}</p>
                {status && (
                  <p className={status.kind === "unanswered" ? "gw-status gw-due" : "gw-status"}>
                    {t(status.kind, { count: status.count })}
                  </p>
                )}
                <p className="gw-acts">
                  <Link className="gw-go" href={item.href}>
                    {t(`tools.${tool}.go`)}
                  </Link>
                  {second && (
                    <Link className="gw-go gw-go-quiet" href={second}>
                      {t("tools.test.go2")}
                    </Link>
                  )}
                </p>
              </article>
            );
          })}
      </div>
    </section>
  );

  return (
    <main className="screen pg gw">
      <PageHead kicker={t("kicker")} title={t("title")}>
        <p className="gw-line">{t("lede")}</p>
      </PageHead>
      {counts === null && read.state === "reading" ? (
        <div className="gw-card">
          <Skeleton lines={4} />
        </div>
      ) : (
        <>
          {half("bring")}
          {half("keep")}
        </>
      )}
    </main>
  );
}
