"use client";

// What every overlay shares (docs/DASHBOARD-OVERHAUL.md A1, G1): focus
// moves in when it opens and goes back to the opener when it closes, Tab
// stays inside it, Escape closes it, and the page behind does not scroll.
// Overlays stack: only the one on top answers the keyboard, so a review
// opened over Lex's sheet closes first.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Open overlays, the top one last. */
const stack: object[] = [];
/** The page's own overflow, kept while any overlay holds the scroll. */
let pageOverflow: string | null = null;

/**
 * Pure: where Tab goes inside a trap of `count` stops when the focus is on
 * stop `index` (-1: outside them). The index to focus, or null to let the
 * browser move on its own.
 */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift) return index <= 0 ? count - 1 : null;
  return index === -1 || index === count - 1 ? 0 : null;
}

/** The stops inside `root` that can take focus right now. */
/**
 * How far a box must move sideways to sit inside the window with `pad` to
 * spare: positive is rightwards. Nothing when it already fits; a box wider
 * than the room is laid from the left edge, where reading starts.
 */
export function nudgeInto(left: number, right: number, viewport: number, pad: number): number {
  if (left < pad || right - left > viewport - 2 * pad) return pad - left;
  if (right > viewport - pad) return viewport - pad - right;
  return 0;
}

export function stops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Makes `root` behave as a modal overlay while `open`. Focus goes to the
 * element marked `data-autofocus`, else the first stop, else the root.
 */
export function useOverlay(
  open: boolean,
  onClose: () => void,
  root: RefObject<HTMLElement | null>,
): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = {};
    stack.push(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = root.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? (el ? stops(el)[0] : null);
    (first ?? el)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !root.current) return;
      const els = stops(root.current);
      const at = els.indexOf(document.activeElement as HTMLElement);
      const to = trapTarget(els.length, at, e.shiftKey);
      if (to !== null) {
        e.preventDefault();
        els[to]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    const html = document.documentElement;
    if (pageOverflow === null) pageOverflow = html.style.overflow;
    html.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && pageOverflow !== null) {
        html.style.overflow = pageOverflow;
        pageOverflow = null;
      }
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, root]);
}

/** Whether any overlay is open: global shortcuts stand down while one is. */
export function overlayOpen(): boolean {
  return stack.length > 0;
}
