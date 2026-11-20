"use client";

// What is news in Home's activity feed (docs/DASHBOARD-OVERHAUL.md C6): the
// rows that arrived since the owner last looked at it. Home holds this, not
// the feed, so it outlives the tab: an answer recorded on "Needs you" is
// still marked when "Activity" is opened after it. A marked row sits on the
// marker for a moment and is counted once for the polite live line.
// activity-model.ts decides what is news; this keeps the account.

import { useEffect, useRef, useState } from "react";
import type { FeedRow, FeedSeen, FeedSources } from "./activity-model";
import { newKeys, remember } from "./activity-model";

/** How long a row that has just arrived stays on the marker. */
export const MARK_MS = 2000;

const NONE: ReadonlySet<string> = new Set();

export interface FeedNews {
  /** The rows on the marker now. */
  fresh: ReadonlySet<string>;
  /** How many arrived together, for the live line; nought once the mark has gone. */
  arrived: number;
}

export function useFeedNews(
  rows: readonly FeedRow[],
  sources: FeedSources,
  /** Whether the feed is on screen: only then is a row seen. */
  looked: boolean,
): FeedNews {
  const seen = useRef<FeedSeen | null>(null);
  const timer = useRef<number | null>(null);
  const [news, setNews] = useState<FeedNews>({ fresh: NONE, arrived: 0 });
  const { log, proposals } = sources;

  useEffect(() => {
    const keys = looked ? newKeys(seen.current, rows) : [];
    seen.current = remember(seen.current, rows, { log, proposals }, looked);
    if (keys.length === 0) return;
    setNews({ fresh: new Set(keys), arrived: keys.length });
    // The mark's own clock: a later read with no news must not cut it short or leave it on.
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setNews({ fresh: NONE, arrived: 0 });
    }, MARK_MS);
  }, [rows, log, proposals, looked]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return news;
}
