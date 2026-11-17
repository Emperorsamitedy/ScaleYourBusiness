"use client";

// A thin cobalt bar across the top while the next screen loads
// (docs/DASHBOARD-OVERHAUL.md B7). Cobalt means "the machine is working
// right now" everywhere in the app, and a page on its way is exactly
// that. It starts when an in-app link is clicked (or when the palette or a
// shortcut says it is moving, through the NAVIGATE event) and ends when
// the path changes, or after fifteen seconds whatever happens.

import { useEffect, useState } from "react";

/** Fired on `window` by code that moves the page itself (router.push). */
export const NAVIGATE = "scalex:navigate";

const AT_MOST_MS = 15_000;

/** Pure: whether a click on this link leaves the page for another in-app one. */
export function leavesPage(
  link: { href: string; target?: string | null; download?: boolean },
  here: { origin: string; pathname: string },
): boolean {
  if (link.download || (link.target && link.target !== "_self")) return false;
  let to: URL;
  try {
    to = new URL(link.href, here.origin);
  } catch {
    return false;
  }
  return to.origin === here.origin && to.pathname !== here.pathname;
}

export function RouteProgress({ path }: { path: string }) {
  const [moving, setMoving] = useState(false);

  // Arrived.
  useEffect(() => setMoving(false), [path]);

  useEffect(() => {
    const start = () => setMoving(true);
    // Capture: the router's own handler takes the click before it bubbles.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (
        leavesPage(
          { href: a.href, target: a.getAttribute("target"), download: a.hasAttribute("download") },
          window.location,
        )
      ) {
        start();
      }
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener(NAVIGATE, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(NAVIGATE, start);
    };
  }, []);

  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => setMoving(false), AT_MOST_MS);
    return () => window.clearTimeout(timer);
  }, [moving]);

  return moving ? <div className="app-progress" aria-hidden="true" /> : null;
}
