"use client";

// "What you get back" — P1-55, as a reel rather than three static cards.
//
// Three scenes play in one instrument frame: where the month goes, how
// wrong a recommendation can be before it costs money, and what the
// system watched afterwards. Each scene assembles itself — segments
// scale out, a line strokes itself in, meters fill against thresholds —
// then hands over to the next.
//
// Still a DOM animation rather than a video: sharp on any display, no
// download, and it can never fall out of step with the product it shows.
// prefers-reduced-motion holds scene one, fully drawn, and stops there.

import { useEffect, useState } from "react";

const SCENE_MS = 5400;

const SCENES = [
  { key: "month", title: "Where the month goes", sub: "4 500 000 HUF of revenue, by what it paid for" },
  { key: "risk", title: "How wrong I can be before it hurts", sub: "Raise the price 20% — you'd have to lose 53% of sales to be worse off" },
  { key: "watch", title: "What I watched afterwards", sub: "Weekly snapshots against the thresholds that would interrupt you" },
] as const;

function MonthScene() {
  const segs = [
    { label: "materials & making", value: "3 465 000", pct: 77, cls: "m1" },
    { label: "fixed costs", value: "540 000", pct: 12, cls: "m2" },
    { label: "you keep", value: "495 000", pct: 11, cls: "m3" },
  ];
  return (
    <div className="reel-month">
      <div className="reel-bar">
        {segs.map((s, i) => (
          <span
            key={s.cls}
            className={`reel-seg ${s.cls}`}
            style={{ flex: s.pct, animationDelay: `${i * 180}ms` }}
          >
            <em>{s.label}</em>
            <b>{s.value}</b>
          </span>
        ))}
      </div>
      <div className="reel-brk">
        <span className="reel-brk-line" />
        <span className="reel-brk-cap">520 000 recoverable · 11.6%</span>
      </div>
    </div>
  );
}

function RiskScene() {
  return (
    <svg viewBox="0 0 520 190" className="reel-svg" aria-hidden="true">
      <defs>
        <linearGradient id="reelGood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59b4b" stopOpacity=".26" />
          <stop offset="100%" stopColor="#f59b4b" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="reelBad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff7a72" stopOpacity=".04" />
          <stop offset="100%" stopColor="#ff7a72" stopOpacity=".2" />
        </linearGradient>
      </defs>
      <line x1="46" y1="146" x2="500" y2="146" stroke="rgba(255,255,255,.16)" strokeDasharray="4 5" />
      <text x="40" y="150" textAnchor="end" className="reel-ax">today</text>
      <path className="reel-area" d="M46,26 L426,146 L46,146 Z" fill="url(#reelGood)" />
      <path className="reel-area2" d="M426,146 L500,169 L500,146 Z" fill="url(#reelBad)" />
      <path
        className="reel-line"
        d="M46,26 L500,169"
        fill="none"
        stroke="#f59b4b"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <g className="reel-mark">
        <line x1="426" y1="22" x2="426" y2="162" stroke="#ff7a72" strokeWidth="1.3" strokeDasharray="4 5" />
        <circle cx="426" cy="146" r="5.5" fill="#0a0b0d" stroke="#ff7a72" strokeWidth="2" />
        <text x="420" y="18" textAnchor="end" className="reel-ax hot">break-even −53%</text>
      </g>
      <g className="reel-assume">
        <circle cx="118" cy="49" r="15" fill="#f59b4b" opacity=".16" />
        <circle cx="118" cy="49" r="6" fill="#f59b4b" />
        <text x="136" y="46" className="reel-note">we assume −8%</text>
        <text x="136" y="61" className="reel-ax">+160 200 HUF / month</text>
      </g>
      <text x="46" y="182" className="reel-ax">sales lost →</text>
    </svg>
  );
}

function WatchScene() {
  const rows = [
    { k: "orders / week", v: "74", lit: 17, cells: 24, tone: "good", note: "clear" },
    { k: "gross margin", v: "23%", lit: 11, cells: 24, tone: "warn", note: "3 pts of headroom" },
    { k: "markets share", v: "54%", lit: 14, cells: 24, tone: "bad", note: "−4 pts on last week" },
  ];
  return (
    <div className="reel-watch">
      {rows.map((r, i) => (
        <div className="reel-wrow" key={r.k}>
          <span className="reel-wk">{r.k}</span>
          <span className={`reel-meter ${r.tone}`}>
            {Array.from({ length: r.cells }, (_, c) => (
              <i
                key={c}
                className={c < r.lit ? "on" : ""}
                style={{ animationDelay: `${i * 160 + c * 26}ms` }}
              />
            ))}
            <b className="reel-thresh" style={{ left: "78%" }} />
          </span>
          <span className="reel-wv">{r.v}</span>
          <span className="reel-wn">{r.note}</span>
        </div>
      ))}
      <div className="reel-verdict">
        <i className="reel-pip" />
        nothing crossed a threshold · next snapshot sunday
      </div>
    </div>
  );
}

export function Reel() {
  const [i, setI] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setStill(true);
  }, []);

  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => setI((n) => (n + 1) % SCENES.length), SCENE_MS);
    return () => clearTimeout(t);
  }, [i, still]);

  const scene = SCENES[i]!;

  return (
    <div className="reel" role="img" aria-label="Three of the things the diagnosis produces">
      <header className="reel-head">
        <span>{scene.title}</span>
        <span className="reel-count">
          {String(i + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")}
        </span>
      </header>

      <div className={still ? "reel-stage still" : "reel-stage"} key={i}>
        {scene.key === "month" && <MonthScene />}
        {scene.key === "risk" && <RiskScene />}
        {scene.key === "watch" && <WatchScene />}
      </div>

      <footer className="reel-foot">
        <span className="reel-sub">{scene.sub}</span>
        <span className="reel-ticks" aria-hidden="true">
          {SCENES.map((s, n) => (
            <i key={s.key} className={n === i ? "on" : ""}>
              <b style={{ animationDuration: `${SCENE_MS}ms` }} />
            </i>
          ))}
        </span>
      </footer>
    </div>
  );
}
