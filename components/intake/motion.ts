// Intake motion timing — the JS half of the record motion (ux-spec §2).
//
// The card's depart runs on var(--d-record) in app/intake.css, so the
// JS wait reads the same token: one number, so they cannot drift apart.
// Under prefers-reduced-motion every duration is zero — the CSS tokens
// already are (app/sheet.css), and the timers follow.

/** ux-spec §2: 280ms record. The fallback when the token can't be read. */
export const RECORD_MS = 280;
/** ux-spec §4.2: the single-select confirm beat. */
export const CONFIRM_MS = 130;

/** "280ms" → 280, "0.3s" → 300, "0ms" → 0; null when unparseable. */
export function parseCssMs(raw: string): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === "s" ? Math.round(n * 1000) : Math.round(n);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A beat that disappears under reduced motion. */
export function beat(ms: number, reduced: boolean = prefersReducedMotion()): number {
  return reduced ? 0 : ms;
}

/** The depart wait: the --d-record token, or zero under reduced motion. */
export function departMs(): number {
  if (prefersReducedMotion()) return 0;
  if (typeof document === "undefined") return RECORD_MS;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--d-record");
  return parseCssMs(raw) ?? RECORD_MS;
}
