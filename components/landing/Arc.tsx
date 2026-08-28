"use client";

// "What this becomes" — the five-stage arc.
//
// The page above this sells one thing: a diagnosis. That is all the
// product does today, and the page should never imply otherwise. But the
// thing being built is an operating system, and an owner deciding whether
// to spend fifteen minutes deserves to know where it goes.
//
// So this draws the whole arc as one instrument rail — and tells the
// truth with the drawing rather than with a disclaimer. The spine runs
// SOLID through the stage that exists and DASHED through the four that
// don't; the charge travelling it is bright over built ground and faint
// over planned ground. The capability ring at each station fills further
// along the rail, because the scope genuinely grows.
//
// Nothing here is dated. Dates on a landing page are a promise; an
// ordered plan is a statement of intent, which is what this is.

import { useEffect, useRef, useState } from "react";

const CYCLE_MS = 4600;
const NODES = 5;
const X0 = 92;
const GAP = 194;
const Y = 78;
const R = 27;

interface Stage {
  n: string;
  verb: string;
  state: "live" | "next" | "planned";
  mark: string;
  head: string;
  body: string;
}

const STAGES: Stage[] = [
  {
    n: "01",
    verb: "Understands",
    state: "live",
    mark: "working today",
    head: "It learns the business, one answer at a time",
    body: "Fifteen minutes of plain questions become a profile where every fact carries its source and its confidence — and then a diagnosis, with the arithmetic shown for every figure rather than asserted.",
  },
  {
    n: "02",
    verb: "Measures",
    state: "next",
    mark: "being built next",
    head: "Then it stops taking your word for it",
    body: "Read-only links to your payments, your shop and your ad accounts. The figure you estimated stays in your history with your name on it; what actually happened takes its place.",
  },
  {
    n: "03",
    verb: "Proposes",
    state: "planned",
    mark: "planned",
    head: "Then it does the work, and asks first",
    body: "Marketing arrives as proposals you approve or decline, checked against your limits before you ever see them. Say “never discount” once and a discount is never proposed again.",
  },
  {
    n: "04",
    verb: "Answers",
    state: "planned",
    mark: "planned",
    head: "Then it takes the questions you answer twice a day",
    body: "Chat and support email — always identifying itself as an AI, and handing you anything it should not be deciding on its own.",
  },
  {
    n: "05",
    verb: "Forecasts",
    state: "planned",
    mark: "planned",
    head: "Then it sees it coming",
    body: "Stock about to run out, cash about to get tight, and the season that catches you the same way it did last year.",
  },
];

// Rounded for the same reason as Hud.tsx: unrounded trigonometry hydrates
// with a last-bit mismatch on every tick.
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Graduation marks around a station — what makes it read as an instrument. */
function Ring({ cx, count = 24 }: { cx: number; count?: number }) {
  return (
    <g>
      {Array.from({ length: count }, (_, i) => {
        const t = ((360 / count) * i - 90) * (Math.PI / 180);
        const major = i % 6 === 0;
        const r1 = R + 7;
        const r2 = R + (major ? 12 : 10);
        return (
          <line
            key={i}
            x1={r3(cx + r1 * Math.cos(t))}
            y1={r3(Y + r1 * Math.sin(t))}
            x2={r3(cx + r2 * Math.cos(t))}
            y2={r3(Y + r2 * Math.sin(t))}
            strokeWidth={major ? 1.2 : 0.7}
          />
        );
      })}
    </g>
  );
}

/** Arc for a fraction of the ring, from 12 o'clock. */
function capPath(cx: number, frac: number): string {
  const span = Math.min(0.999, frac) * 360;
  const p = (deg: number): string => {
    const t = ((deg - 90) * Math.PI) / 180;
    return `${(cx + R * Math.cos(t)).toFixed(2)},${(Y + R * Math.sin(t)).toFixed(2)}`;
  };
  return `M${p(0)} A${R},${R} 0 ${span > 180 ? 1 : 0} 1 ${p(span)}`;
}

export function Arc() {
  const [i, setI] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setStill(true);
  }, []);

  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => setI((n) => (n + 1) % NODES), CYCLE_MS);
    return () => clearTimeout(t);
  }, [i, still]);

  const stage = STAGES[i]!;
  const cxOf = (n: number): number => X0 + n * GAP;
  const lastX = cxOf(NODES - 1);

  // On a narrow screen the rail is wider than its box, so the station the
  // detail below is describing can sit off-screen. Keep it in view.
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rail.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const left = (cxOf(i) / 960) * el.scrollWidth - el.clientWidth / 2;
    el.scrollTo({
      left: Math.max(0, left),
      behavior: still ? "auto" : "smooth",
    });
  }, [i, still]);

  return (
    <div className={still ? "arc still" : "arc"}>
      <header className="arc-head">
        <span>Where this goes</span>
        <span className="arc-mono">5 stages · 1 of them exists</span>
      </header>

      <div className="arc-rail" ref={rail}>
        <svg
          viewBox="0 0 960 190"
          className="arc-svg"
          role="img"
          aria-label="Five stages: understands, measures, proposes, answers, forecasts. Only the first is built."
        >
          <defs>
            <linearGradient id="arcLive" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#e1560f" />
              <stop offset="100%" stopColor="#f59b4b" />
            </linearGradient>
          </defs>

          {/* the spine: solid over what is built, dashed over what is not */}
          <line
            className="arc-spine live"
            x1="14"
            y1={Y}
            x2={X0}
            y2={Y}
            stroke="url(#arcLive)"
            strokeWidth="1.8"
          />
          <line
            className="arc-spine plan"
            x1={X0}
            y1={Y}
            x2={lastX}
            y2={Y}
            strokeDasharray="4 7"
          />

          {/* one charge, bright over built ground and faint over planned */}
          <circle className="arc-pulse" cy={Y} r="4.5" fill="#ffb25c" />

          {STAGES.map((s, n) => {
            const cx = cxOf(n);
            const cls = [
              "arc-node",
              s.state === "live" ? "live" : "plan",
              n === i ? "on" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <g
                key={s.n}
                className={cls}
                role="button"
                tabIndex={0}
                aria-label={`${s.n} — ${s.verb}, ${s.mark}`}
                onClick={() => setI(n)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setI(n);
                  }
                }}
              >
                <circle className="arc-hit" cx={cx} cy={Y} r={R + 16} />
                <Ring cx={cx} />
                <circle className="arc-well" cx={cx} cy={Y} r={R} />
                <circle className="arc-track" cx={cx} cy={Y} r={R} />
                {/* the ring fills further along the rail — the scope grows */}
                <path className="arc-cap" d={capPath(cx, (n + 1) / NODES)} />
                {s.state === "live" && (
                  <circle className="arc-ping" cx={cx} cy={Y} r={R} />
                )}
                <text className="arc-num" x={cx} y={Y + 5} textAnchor="middle">
                  {s.n}
                </text>
                <text className="arc-verb" x={cx} y={Y + R + 34} textAnchor="middle">
                  {s.verb}
                </text>
                <text className="arc-state" x={cx} y={Y + R + 50} textAnchor="middle">
                  {s.state === "live" ? "● LIVE" : s.state === "next" ? "NEXT" : "PLANNED"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="arc-detail" key={i}>
        <span className="arc-d-n">{stage.n}</span>
        <div className="arc-d-body">
          <h3>{stage.head}</h3>
          <p>{stage.body}</p>
        </div>
        <span className={`arc-d-mark ${stage.state}`}>{stage.mark}</span>
      </div>

      <footer className="arc-foot">
        <i className="arc-foot-pip" aria-hidden="true" />
        <p>
          Stage three onward can <em>act</em>. None of them act alone — every action is a proposal
          you approve, checked against limits you set, with one switch that stops all of it.{" "}
          <strong>Only stage one exists today</strong>, which you can verify the easy way: it is the
          only one you can use.
        </p>
      </footer>
    </div>
  );
}
