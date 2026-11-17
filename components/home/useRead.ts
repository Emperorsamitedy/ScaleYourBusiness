"use client";

// One read of one of Home's JSON routes, behaving as read-model.ts says
// (docs/DASHBOARD-OVERHAUL.md C1): what was read last shows at once on a
// return to Home and is refreshed behind it; the read repeats on `every`
// while the tab is visible and when the window regains focus, waiting for a
// read that is still out rather than dropping its answer; a failure keeps
// what was on screen; `reload` reads again now (Retry, or after an answer),
// whatever is out. The cache lives for the page's life only: every sign-in, sign-out
// link and business switch is a full page load, which empties it, and a
// refused read (401) empties it at once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Read } from "./home-model";
import { readOutcome } from "./home-model";
import type { Outcome } from "./read-model";
import { focusDue, keepable, seeded, settled, starting, tickDue } from "./read-model";

const cache = new Map<string, { data: unknown; at: number }>();

/** Forgets every read: the sign-in is gone. */
export function forgetReads(): void {
  cache.clear();
}

export function useRead<T>(url: string, opts: { every?: number } = {}): [Read<T>, () => void] {
  const { every } = opts;
  const [read, setRead] = useState<Read<T>>(() => {
    const hit = cache.get(url);
    return seeded(hit && keepable(hit.at, Date.now()) ? (hit.data as T) : undefined);
  });
  /** The newest read's number: an older one coming back late is dropped. */
  const seq = useRef(0);
  const lastAt = useRef<number | null>(null);
  /** Since when the newest read has been out; null once it is back. */
  const outSince = useRef<number | null>(null);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    lastAt.current = Date.now();
    outSince.current = lastAt.current;
    setRead((prev) => starting(prev));
    fetch(url, { cache: "no-store" })
      .then(async (r): Promise<Outcome<T>> => {
        const kind = readOutcome(r.status);
        return kind === "read" ? { kind, data: (await r.json()) as T } : { kind };
      })
      .catch((): Outcome<T> => ({ kind: "failed" }))
      .then((outcome) => {
        if (mine !== seq.current) return;
        outSince.current = null;
        if (outcome.kind === "read") cache.set(url, { data: outcome.data, at: Date.now() });
        if (outcome.kind === "signed_out") forgetReads();
        setRead((prev) => settled(prev, outcome));
      });
  }, [url]);

  /** A read set off by the clock or the window, which waits for one still out. */
  const tick = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    if (tickDue(outSince.current, Date.now())) reload();
  }, [reload]);

  useEffect(() => {
    reload();
    // Leaving the page: whatever is still out is dropped when it lands.
    return () => {
      seq.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    const onFocus = () => {
      if (focusDue(lastAt.current, Date.now())) tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [tick]);

  useEffect(() => {
    if (!every) return;
    const timer = window.setInterval(tick, every);
    return () => window.clearInterval(timer);
  }, [every, tick]);

  return [read, reload];
}
