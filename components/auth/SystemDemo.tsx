"use client";

// The system, working — a looped four-beat demo for the auth screen,
// sized to mirror the form card beside it. Each beat is a small
// analyst's panel: one tag, one hero figure, one chart, one quiet
// footnote. Built from the product's own design language rather than
// a compressed gif; nothing is claimed here that the product doesn't
// do.

import { useEffect, useRef, useState } from "react";

const TYPED = "$1,850 rent + $320 software";
const STEP_MS = 4200;
const TYPE_MS = 46;

export function SystemDemo() {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  const typing = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const cycle = setInterval(() => setStep((s) => (s + 1) % 4), STEP_MS);
    return () => clearInterval(cycle);
  }, []);

  useEffect(() => {
    if (typing.current) clearInterval(typing.current);
    if (step !== 0) return;
    setTyped("");
    let i = 0;
    typing.current = setInterval(() => {
      i += 1;
      setTyped(TYPED.slice(0, i));
      if (i >= TYPED.length && typing.current) clearInterval(typing.current);
    }, TYPE_MS);
    return () => {
      if (typing.current) clearInterval(typing.current);
    };
  }, [step]);

  return (
    <div className="sd-stack" aria-hidden="true">
      {/* beat 1 — the interview asks, the profile fills */}
      <div className={`sd-card ${step === 0 ? "on" : ""}`}>
        <span className="sd-tag">5.1 · core</span>
        <p className="sd-q">What do you pay every month, regardless of sales?</p>
        <div className="sd-field">
          {typed}
          <span className="sd-caret" />
        </div>
        <div className="sd-meter">
          <div className="sd-meter-head">
            <span>profile completeness</span>
            <span>61%</span>
          </div>
          <div className="sd-track">
            <i style={{ width: "61%" }} />
          </div>
        </div>
      </div>

      {/* beat 2 — the answer is a fact with a breakdown */}
      <div className={`sd-card ${step === 1 ? "on" : ""}`}>
        <span className="sd-tag">recorded</span>
        <p className="sd-hero">$2,170</p>
        <span className="sd-hero-label">fixed costs / month</span>
        <div className="sd-split">
          <i style={{ width: "85%" }} className="a" />
          <i style={{ width: "15%" }} className="b" />
        </div>
        <div className="sd-legend">
          <span>
            <i className="a" /> rent $1,850
          </span>
          <span>
            <i className="b" /> software $320
          </span>
        </div>
        <span className="sd-prov">owner · stated · confidence 75%</span>
      </div>

      {/* beat 3 — the diagnosis, as a gauge */}
      <div className={`sd-card ${step === 2 ? "on" : ""}`}>
        <span className="sd-tag">
          diagnosis · <b className="sd-sev">high</b>
        </span>
        <p className="sd-hero">74 orders</p>
        <span className="sd-hero-label">break-even / month</span>
        <div className="sd-meter">
          <div className="sd-track sd-gauge">
            <i style={{ width: "82%" }} />
            <b style={{ left: "82%" }} />
          </div>
          <div className="sd-meter-head sd-gauge-foot">
            <span>you average 61</span>
            <span>74 needed</span>
          </div>
        </div>
        <span className="sd-prov">rests on: fixed costs · price $49</span>
      </div>

      {/* beat 4 — measured truth replaces the estimate */}
      <div className={`sd-card ${step === 3 ? "on" : ""}`}>
        <span className="sd-tag">measured · stripe</span>
        <div className="sd-stats">
          <div className="sd-stat">
            <span className="sd-stat-num">$6,910</span>
            <span className="sd-stat-label">revenue</span>
          </div>
          <div className="sd-stat">
            <span className="sd-stat-num">141</span>
            <span className="sd-stat-label">orders</span>
          </div>
          <div className="sd-stat">
            <span className="sd-stat-num">31%</span>
            <span className="sd-stat-label">margin</span>
          </div>
        </div>
        <div className="sd-bars">
          {[34, 52, 41, 66, 58, 74, 90].map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} className={i === 6 ? "on" : ""} />
          ))}
        </div>
        <div className="sd-delta">
          <span className="sd-delta-chip">−17%</span>
          <span>est. $8,300 → measured $6,910</span>
        </div>
      </div>

      <div className="sd-dots">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={step === i ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}
