"use client";

// Home's activity feed (docs/DASHBOARD-OVERHAUL.md C6): what Lex read,
// noticed, checked and proposed, and what the owner answered, newest
// first, each with how long ago and a worded tag. A row opens to its
// detail: the whole line and its screen, or the owner's own reason and
// the decision itself. The list is read again on its own (Home's reads),
// and a row that arrived since the owner last looked sits on the marker for
// a moment and is counted in a polite live line: the system's own sign for
// ink just laid down. activity-model.ts decides the rows, useFeedNews.ts
// which of them are news; this file draws them.
//
// What was read and what was checked come several to a day and all alike
// (each source, each goal), so a day's lines of one such kind are one row:
// the newest, with "and 3 more" beside its time, and the others under it
// when it is opened (stackFeed). Nothing is left out; eight rows now reach
// back days where they reached back hours.

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import type en from "../../messages/en.json";
import { logWords } from "../../lib/watch/words";
import { useTr } from "../sheet/useTr";
import type { FeedRow, FeedTag } from "./activity-model";
import { stackFeed } from "./activity-model";
import { agoText, clockTime, fullWhen } from "./format";
import type { FeedNews } from "./useFeedNews";

/** The tint behind each tag's word; the word carries the meaning. */
const TONE: Readonly<Record<FeedTag, "ok" | "low" | "drift">> = {
  read: "low",
  noticed: "drift",
  checked: "low",
  watch: "low",
  proposed: "low",
  approved: "ok",
  done: "ok",
  declined: "low",
  changes: "low",
  expired: "drift",
  blocked: "drift",
};

type NavItemKey = keyof (typeof en)["nav"]["item"];
/** The menu's own name for the screen a log line belongs to. */
const SCREEN: Readonly<Record<string, NavItemKey>> = {
  "/connections": "connections",
  "/watch": "watch",
  "/hours": "hours",
  "/progress": "goals",
  "/competitors": "competitors",
  "/cash": "cash",
  "/stock": "stock",
  "/reviews": "reviews",
  "/history": "history",
  "/content": "content",
  "/proposals": "proposals",
};

/** Eight rows at first: a feed is glanced at, and the rest is one press away. */
const FIRST = 8;
const STEP = 12;

export function ActivityFeed({
  rows,
  news,
  onReview,
}: {
  rows: readonly FeedRow[];
  /** The rows that arrived since the feed was last looked at (useFeedNews.ts). */
  news: FeedNews;
  /** Opens the decision behind a row. */
  onReview: (id: string) => void;
}) {
  const t = useTranslations("home");
  const nav = useTranslations("nav");
  const { tr: ww, locale } = useTr("watchWords");
  const [shown, setShown] = useState(FIRST);
  const [open, setOpen] = useState<string | null>(null);
  const { fresh, arrived } = news;
  const entries = useMemo(() => stackFeed(rows), [rows]);

  const now = Date.now();
  if (rows.length === 0) return <p className="home-empty">{t("feed.empty")}</p>;
  /** A row's line: a log line read back in the reader's language, a proposal's own summary. */
  const line = (r: FeedRow): string =>
    (r.subject ? `${r.subject} · ` : "") +
    (r.source === "log" ? logWords(r.text, { tr: ww, locale }) : r.text);
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {arrived > 0 ? t("feed.new", { count: arrived }) : ""}
      </p>
      <ul className="hf">
        {entries.slice(0, shown).map((e) => {
          const r = e.row;
          const isOpen = open === e.key;
          const screen = r.href ? SCREEN[r.href] : undefined;
          // A stack is news when any line in it is.
          const isNew = fresh.has(r.key) || e.rest.some((x) => fresh.has(x.key));
          return (
            <li key={e.key} className={isNew ? "hf-row is-new" : "hf-row"}>
              <button
                type="button"
                className="hf-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : e.key)}
              >
                <span className="hf-meta">
                  <span className={`flag ${TONE[r.tag]}`}>{t(`feed.tag.${r.tag}`)}</span>
                  <span className="hf-when" title={fullWhen(r.ms, locale)}>
                    {agoText(r.ms, now, locale)}
                  </span>
                  {e.rest.length > 0 && (
                    <span className="hf-count">{t("feed.stack", { count: e.rest.length })}</span>
                  )}
                </span>
                <span className={isOpen ? "hf-text open" : "hf-text"}>{line(r)}</span>
                <ChevronDown
                  className={isOpen ? "hf-chev open" : "hf-chev"}
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              </button>
              {isOpen && (
                <div className="hf-more">
                  {r.said && <p className="hf-said">{t("feed.said", { words: r.said })}</p>}
                  <p className="hf-at">{fullWhen(r.ms, locale)}</p>
                  {e.rest.length > 0 && (
                    <ul className="hf-stack">
                      {e.rest.map((x) => (
                        <li key={x.key}>
                          <span className="hf-when">{clockTime(x.ms, locale)}</span>
                          <span>{line(x)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.proposal ? (
                    <button
                      type="button"
                      className="home-btn"
                      onClick={() => onReview(r.proposal!)}
                    >
                      {t("decide.open")}
                    </button>
                  ) : (
                    r.href &&
                    screen && (
                      <Link className="home-btn" href={r.href}>
                        {nav(`item.${screen}`)}
                      </Link>
                    )
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {entries.length > shown && (
        <button type="button" className="home-more" onClick={() => setShown((n) => n + STEP)}>
          {t("feed.more")}
        </button>
      )}
    </>
  );
}
