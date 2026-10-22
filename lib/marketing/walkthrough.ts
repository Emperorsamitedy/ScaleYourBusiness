// The landing page's product walkthrough, as a pure function of time.
//
// The owner's design (2026-10-17) plays a 36-second "video" in six
// six-second chapters, drawn live rather than streamed: a cursor glides to
// a control, a ripple marks the click, and the screen answers. frame(t)
// returns everything the player draws at second t, so the timings live in
// one place and are testable; components/marketing/Walkthrough.tsx only
// ticks the clock and renders. The business is whichever illustrative one
// in sample-diagnosis.ts the visitor picked; the webshop by default.

import { SHOP_SAMPLE, type DemoSample } from "./sample-diagnosis";

export interface Chapter {
  n: string;
  title: string;
  caption: string;
  /** The fake app's breadcrumb. */
  crumb: string;
  /** The fake app's status, top right. */
  state: string;
}

export const CHAPTERS: readonly Chapter[] = [
  {
    n: "01",
    title: "Connect",
    caption: "Connect your accounts — read-only, two minutes.",
    crumb: "Connections",
    state: "connecting",
  },
  {
    n: "02",
    title: "Questions",
    caption: "Answer a few questions only you can answer.",
    crumb: "Interview",
    state: "recording",
  },
  {
    n: "03",
    title: "The watch",
    caption: "We read every number. Nothing gets touched.",
    crumb: "Watching",
    state: "watching",
  },
  {
    n: "04",
    title: "Report",
    caption: "Every leak, measured and priced in euros.",
    crumb: "Report",
    state: "report ready",
  },
  {
    n: "05",
    title: "Approve",
    caption: "Nothing runs until you press Approve.",
    crumb: "Waiting for you",
    state: "1 decision",
  },
  {
    n: "06",
    title: "Results",
    caption: "Then see exactly what each fix earned.",
    crumb: "Outcomes",
    state: "measuring",
  },
];

export const WALK_SECONDS = 36;
export const SCENE_SECONDS = 6;
/** The clock ticks in tenths of a second, every 100 ms. */
export const TICK_MS = 100;
/** Under prefers-reduced-motion the player opens paused on this second: the report. */
export const REDUCED_MOTION_SECOND = 20;

export interface Frame {
  scene: number;
  /** Progress through the scene, 0–1. */
  p: number;
  /** Cursor position in % of the stage, or null when the scene has none. */
  cursor: { x: number; y: number } | null;
  ripple: { x: number; y: number; opacity: number; scale: number } | null;
  connect: { pressed: boolean; done: boolean; bar: number };
  question: { hovered: boolean; picked: boolean; fact: boolean };
  watch: { filled: number; day: number; readings: number };
  report: { shown: number; total: { low_minor: number; high_minor: number } | null };
  approve: { pressed: boolean; approved: boolean };
  /** `metric` runs from the outcome's before to its after; null until measured. */
  results: { up: string; down: string; recovered_minor: number; metric: number | null };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

type Key = readonly [at: number, x: number, y: number];

/** Each scene's cursor keyframes (p, x %, y %); null hides the cursor. */
const PATHS: readonly (readonly Key[] | null)[] = [
  [
    [0, 70, 92],
    [0.42, 12, 61],
    [1, 12, 61],
  ],
  [
    [0, 72, 88],
    [0.42, 41, 43],
    [1, 41, 43],
  ],
  null,
  [
    [0, 60, 92],
    [0.65, 88, 16],
    [1, 88, 16],
  ],
  [
    [0, 62, 95],
    [0.42, 12, 69],
    [1, 12, 69],
  ],
  null,
];

/** Where in each scene the cursor clicks; -1 for no click. */
const CLICK_AT = [0.5, 0.5, -1, -1, 0.5, -1] as const;

/** Step 6's 40 small candles, drawn up to `upto`. Same generator and seed as the design. */
function resultCandles(upto: number): { up: string; down: string } {
  let seed = 3;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let up = "";
  let down = "";
  let prev = 105;
  for (let c = 0; c < 40; c++) {
    const drift = c < 20 ? 0 : -1.6;
    const o = prev;
    const cl = Math.max(20, Math.min(135, o + (rand() - 0.5) * 16 + drift));
    if (c < upto) {
      const xx = 6 + c * 14.8;
      const tt = Math.min(o, cl);
      const hh = Math.max(2, Math.abs(o - cl));
      const seg =
        `M${xx + 2.6} ${(tt - 4 - rand() * 6).toFixed(1)}h1.2V${(tt + hh + 4 + rand() * 6).toFixed(1)}h-1.2Z` +
        `M${xx} ${tt.toFixed(1)}h7v${hh.toFixed(1)}h-7Z`;
      // SVG y grows downward: a falling y is a rising value.
      if (cl <= o) up += seg;
      else down += seg;
    }
    prev = cl;
  }
  return { up: up || "M0 0", down: down || "M0 0" };
}

export function frame(t: number, sample: DemoSample = SHOP_SAMPLE): Frame {
  const { leak, markers, outcome } = sample;
  const scene = Math.min(5, Math.floor(t / SCENE_SECONDS));
  const p = (t - scene * SCENE_SECONDS) / SCENE_SECONDS;

  let cursor: Frame["cursor"] = null;
  let ripple: Frame["ripple"] = null;
  const path = PATHS[scene];
  if (path) {
    let a = path[0]!;
    let b = path[1]!;
    for (let i = 1; i < path.length; i++) {
      const key = path[i]!;
      if (p <= key[0]) {
        a = path[i - 1]!;
        b = key;
        break;
      }
      a = key;
      b = key;
    }
    const k = b[0] === a[0] ? 1 : ease(clamp((p - a[0]) / (b[0] - a[0])));
    const x = lerp(a[1], b[1], k);
    const y = lerp(a[2], b[2], k);
    cursor = { x, y };
    const clickAt = CLICK_AT[scene] ?? -1;
    const d = Math.abs(p - clickAt);
    if (clickAt >= 0 && d < 0.07) {
      ripple = { x: x + 0.6, y: y + 1.5, opacity: 1 - d / 0.07, scale: 0.6 + d * 8 };
    }
  }

  const filled = Math.floor(clamp(p / 0.9) * 28);
  const tot = clamp((p - 0.7) / 0.25);
  const wholeEuros = (minor: number, k: number) => Math.round((minor / 100) * k) * 100;

  return {
    scene,
    p,
    cursor,
    ripple,
    connect: { pressed: p > 0.47, done: p > 0.55, bar: clamp((p - 0.58) / 0.35) * 100 },
    question: { hovered: p > 0.4, picked: p > 0.5, fact: p > 0.58 },
    watch: { filled, day: Math.max(1, filled), readings: Math.round(clamp(p / 0.9) * 4212) },
    report: {
      shown: Math.floor(clamp(p / 0.75) * (markers.length + 0.01)),
      total:
        tot > 0
          ? {
              low_minor: wholeEuros(leak.low_minor, tot),
              high_minor: wholeEuros(leak.high_minor, tot),
            }
          : null,
    },
    approve: { pressed: p > 0.45, approved: p > 0.52 },
    results: {
      ...resultCandles(Math.floor(clamp(p / 0.85) * 40)),
      recovered_minor: wholeEuros(outcome.recovered_minor, clamp((p - 0.45) / 0.45)),
      metric:
        p > 0.5 ? outcome.before + clamp((p - 0.5) / 0.4) * (outcome.after - outcome.before) : null,
    },
  };
}
