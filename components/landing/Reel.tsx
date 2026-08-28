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
  { key: "risk", title: "How wrong I can be before it hurts", sub: "Profit change at every level of being wrong about the volume drop" },
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

/** What the recommendation earns at each level of being wrong. */
function RiskScene() {
  // profit change = 1900 × 189 × (1 − loss) − 170 100, in HUF
  const STEPS = [
    { loss: "0%", v: 189_000 },
    { loss: "−10%", v: 153_090 },
    { loss: "−20%", v: 117_180 },
    { loss: "−30%", v: 81_270 },
    { loss: "−40%", v: 45_360 },
    { loss: "−53%", v: 0, breakeven: true },
    { loss: "−60%", v: -26_460 },
  ];
  const SCALE = 189_000;
  const ORIGIN = 34; // % across the track where zero sits

  return (
    <div className="lad">
      <div className="lad-axis">
        <span style={{ left: `${ORIGIN}%` }}>
          <i />
          today
        </span>
        <span className="lad-right">better off →</span>
      </div>

      {STEPS.map((s, i) => {
        const pos = s.v >= 0;
        const w = (Math.abs(s.v) / SCALE) * (100 - ORIGIN - 4);
        return (
          <div className={s.breakeven ? "lad-row be" : "lad-row"} key={s.loss}>
            <span className="lad-loss">{s.loss}</span>
            <span className="lad-track">
              <i className="lad-zero" style={{ left: `${ORIGIN}%` }} />
              <b
                className={pos ? "lad-fill up" : "lad-fill down"}
                style={{
                  left: pos ? `${ORIGIN}%` : `${ORIGIN - w}%`,
                  width: `${Math.max(w, 0.4)}%`,
                  animationDelay: `${i * 110}ms`,
                }}
              />
            </span>
            <span className="lad-v">
              {s.v === 0 ? "0" : `${s.v > 0 ? "+" : "−"}${Math.abs(s.v).toLocaleString("en-US").replace(/,/g, " ")}`}
            </span>
            {s.breakeven && <span className="lad-flag">break-even</span>}
          </div>
        );
      })}

      <p className="lad-note">
        Sales would have to fall <strong>53%</strong> before the price rise costs you anything.
      </p>
    </div>
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
