"use client";

// The system, working — a looped three-beat demo for the auth screen's
// film panel: a question is asked, the answer is recorded with its
// provenance, the diagnosis says something it can prove. Built from
// the product's own design language rather than a compressed gif, so
// it stays crisp and costs nothing to load. The content mirrors what
// the real screens show; nothing is claimed here that the product
// doesn't do.

import { useEffect, useRef, useState } from "react";

const TYPED = "$1,850 rent + $320 software";
const STEP_MS = 4200;
const TYPE_MS = 46;

export function SystemDemo() {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  const typing = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const cycle = setInterval(() => setStep((s) => (s + 1) % 3), STEP_MS);
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
      {/* beat 1 — the interview asks */}
      <div className={`sd-card ${step === 0 ? "on" : ""}`}>
        <span className="sd-tag">5.1 · core</span>
        <p className="sd-q">What does the business pay every month regardless of sales?</p>
        <div className="sd-field">
          {typed}
          <span className="sd-caret" />
        </div>
      </div>

      {/* beat 2 — the answer is a fact with a source */}
      <div className={`sd-card ${step === 1 ? "on" : ""}`}>
        <span className="sd-tag">recorded</span>
        <p className="sd-q">Fixed monthly costs</p>
        <p className="sd-a">$2,170 / month</p>
        <span className="sd-prov">5.1 · owner · stated · confidence 75%</span>
      </div>

      {/* beat 3 — the diagnosis proves what it says */}
      <div className={`sd-card ${step === 2 ? "on" : ""}`}>
        <span className="sd-tag">diagnosis</span>
        <p className="sd-q">
          <b className="sd-sev">high</b> Break-even is 74 orders — you averaged 61 last
          quarter.
        </p>
        <span className="sd-prov">rests on: fixed costs (you told me) · price = 49 USD</span>
      </div>

      <div className="sd-dots">
        {[0, 1, 2].map((i) => (
          <i key={i} className={step === i ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}
