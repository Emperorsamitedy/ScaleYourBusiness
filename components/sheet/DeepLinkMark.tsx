"use client";

// The deep link's landing — feature 33. A chat card's "Open the page"
// goes to a route with ?focus=<element id> (lib/assistant/catalogue.ts).
// The screens load their data after the page does, so the target may not
// exist yet: this waits for it (a bounded watch, not a poll loop), scrolls
// it into view, and marks it with the marker background for a moment so
// the owner's eye lands on exactly what is set now. An id names one
// element; data-focus covers a control drawn in more than one place (the
// stop), and the first visible one wins.

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** How long the target may take to render before the watch gives up. */
const WAIT_MS = 8_000;
/** How long the mark stays — long enough to find, short enough not to linger. */
const MARK_MS = 2_400;

function visible(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0;
}

function findTarget(focus: string): HTMLElement | null {
  const byId = document.getElementById(focus);
  if (visible(byId)) return byId;
  const tagged = document.querySelectorAll(`[data-focus="${CSS.escape(focus)}"]`);
  for (const el of Array.from(tagged)) if (visible(el)) return el;
  return null;
}

function Mark() {
  const path = usePathname();
  // Read through the router, not window.location: on a client-side
  // navigation the effect can run before the address bar is updated.
  const focus = useSearchParams().get("focus");
  useEffect(() => {
    if (!focus) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let marked: HTMLElement | null = null;
    const unmark = () => {
      if (timer) clearTimeout(timer);
      marked?.classList.remove("deeplink-mark");
    };
    const mark = (el: HTMLElement) => {
      marked = el;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
      el.classList.add("deeplink-mark");
      timer = setTimeout(unmark, MARK_MS);
    };
    const now = findTarget(focus);
    if (now) {
      mark(now);
      return unmark;
    }
    const watch = new MutationObserver(() => {
      const el = findTarget(focus);
      if (el) {
        watch.disconnect();
        mark(el);
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const giveUp = setTimeout(() => watch.disconnect(), WAIT_MS);
    return () => {
      watch.disconnect();
      clearTimeout(giveUp);
      unmark();
    };
  }, [path, focus]);
  return null;
}

/** Suspense-wrapped: useSearchParams must not hold a static page back from prerendering. */
export function DeepLinkMark() {
  return (
    <Suspense fallback={null}>
      <Mark />
    </Suspense>
  );
}
