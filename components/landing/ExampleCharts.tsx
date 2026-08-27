"use client";

// Three real report visuals, drawn when they scroll into view — P1-55.
//
// These are the actual charts the diagnosis produces, not stock imagery:
// where the month goes, how a price change survives being wrong, and what
// the system watched week by week. Showing the artefact is a stronger
// claim than describing it.
//
// Each one animates once, on entry, via IntersectionObserver; motion is
// skipped entirely under prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";

function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSeen(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, seen };
}

/** Where a month actually goes — the same bar the report opens with. */
function MonthBar() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const segs = [
    { label: "materials & making", value: "3 465 000", flex: 77, cls: "s1" },
    { label: "fixed costs", value: "540 000", flex: 12, cls: "s2" },
    { label: "you keep", value: "495 000", flex: 11, cls: "s3" },
  ];
  return (
    <figure className="ex" ref={ref}>
      <figcaption>
        <strong>Where the month goes</strong>
        <span>4 500 000 HUF of revenue, split by what it actually paid for</span>
      </figcaption>
      <div className={seen ? "ex-bar in" : "ex-bar"}>
        {segs.map((s, i) => (
          <span
            key={s.cls}
            className={`ex-seg ${s.cls}`}
            style={{ flex: s.flex, transitionDelay: `${i * 110}ms` }}
          >
            <em>{s.label}</em>
            <b>{s.value}</b>
          </span>
        ))}
      </div>
    </figure>
  );
}

/** How wrong an assumption can be before a recommendation loses money. */
function BreakEven() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  return (
    <figure className="ex" ref={ref}>
      <figcaption>
        <strong>How wrong it can be before it hurts</strong>
        <span>Raise the price 20% and you would have to lose 53% of sales to be worse off</span>
      </figcaption>
      <div ref={ref}>
        <svg viewBox="0 0 320 132" className={seen ? "ex-svg in" : "ex-svg"} aria-hidden="true">
          <defs>
            <linearGradient id="exGood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59b4b" stopOpacity=".28" />
              <stop offset="100%" stopColor="#f59b4b" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="26" y1="98" x2="310" y2="98" stroke="rgba(255,255,255,.16)" strokeDasharray="4 4" />
          <path className="ex-area" d="M26,20 L268,98 L26,98 Z" fill="url(#exGood)" />
          <path
            className="ex-line"
            d="M26,20 L310,111"
            fill="none"
            stroke="#f59b4b"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <line x1="268" y1="16" x2="268" y2="110" stroke="#ff7a72" strokeWidth="1.3" strokeDasharray="4 5" />
          <circle className="ex-dot" cx="268" cy="98" r="4.5" fill="#0a0b0d" stroke="#ff7a72" strokeWidth="2" />
          <text x="264" y="12" textAnchor="end" fontFamily="var(--mono)" fontSize="8.5" fill="#ff7a72">
            BREAK-EVEN −53%
          </text>
          <text x="26" y="116" fontFamily="var(--mono)" fontSize="8.5" fill="#6b727c">
            SALES LOST →
          </text>
        </svg>
      </div>
    </figure>
  );
}

/** What the system watched, week by week, and what it would interrupt for. */
function Watched() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const rows = [
    { k: "orders / week", v: "74", w: 62, tone: "good" },
    { k: "gross margin", v: "23%", w: 41, tone: "warn" },
    { k: "markets share", v: "54%", w: 54, tone: "bad" },
  ];
  return (
    <figure className="ex" ref={ref}>
      <figcaption>
        <strong>What it watched afterwards</strong>
        <span>Weekly snapshots against the thresholds that would make it interrupt you</span>
      </figcaption>
      <div className={seen ? "ex-rows in" : "ex-rows"}>
        {rows.map((r, i) => (
          <div className="ex-row" key={r.k}>
            <span className="ex-k">{r.k}</span>
            <span className="ex-track">
              <span
                className={`ex-fill ${r.tone}`}
                style={{ width: `${r.w}%`, transitionDelay: `${i * 130}ms` }}
              />
              <i className="ex-mark" style={{ left: "78%" }} />
            </span>
            <span className="ex-v">{r.v}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function ExampleCharts() {
  return (
    <div className="ex-grid">
      <MonthBar />
      <BreakEven />
      <Watched />
    </div>
  );
}
