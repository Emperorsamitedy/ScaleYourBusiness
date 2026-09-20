"use client";

// The landing demo — P1-55. Answers turning into a diagnosis.
//
// This is the product's entire claim in fifteen seconds: someone types
// three plain answers, and those answers become numbers, a chart, and a
// finding. So the loop runs the real sequence — question rises, answer
// types, chip settles with its provenance — and then the chips physically
// fly into the report they produced, while the figures count up from zero
// and the bars grow.
//
// Deliberately a DOM animation rather than a video: crisp at any size, no
// download, reflows on a phone, and it cannot drift out of date with the
// interface it advertises. Under prefers-reduced-motion it renders the
// finished report with no movement at all.

import { useEffect, useRef, useState } from "react";
import { LeakDial, MarginRadar, MiniGauge, Scanner } from "./Hud";

type Phase = "intake" | "reading" | "report";

interface Answer {
  q: string;
  a: string;
  prov: string;
  gap?: boolean;
}

const ANSWERS: Answer[] = [
  {
    q: "About how much do you make in a typical month?",
    a: "≈ 4 500 000 HUF",
    prov: "4.2 · your estimate",
  },
  { q: "What do you sell, and for how much?", a: "5 products", prov: "3.1 · you told me" },
  { q: "What does the 0.5L cost you to make?", a: "4 090 HUF", prov: "3.4 · you told me" },
];

// The core set, in the order this demo captures them. What is already
// answered lights up; what is coming stays dim, so the panel says "there
// is a structured set of these" without a word of copy.
const CORE_FIELDS = ["monthly revenue", "what you sell", "unit cost", "orders / month"];
const CORE_TOTAL = 27;

const TYPE_MS = 38;
const HOLD_MS = 520;
const READ_MS = 1150;
const REPORT_MS = 5200;

/** Counts a figure up from zero once its phase arrives. */
function useCountUp(target: number, active: boolean, ms = 1100): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) {
      setN(0);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setN(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / ms);
      // ease-out: fast start, settles onto the real number
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, ms]);
  return n;
}

const spaced = (n: number): string => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

export function MorphDemo() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState("");
  const [chips, setChips] = useState<Answer[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [still, setStill] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const showReport = phase === "report" || still;
  const leak = useCountUp(520_000, showReport);
  const margin = useCountUp(23, showReport, 900);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStill(true);
      setChips(ANSWERS);
      setPhase("report");
    }
  }, []);

  useEffect(() => {
    if (still) return;
    const clear = (): void => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    const at = (ms: number, fn: () => void): void => {
      timers.current.push(setTimeout(fn, ms));
    };

    if (phase === "intake") {
      const step = ANSWERS[index]!;
      let t = 380;
      for (let i = 1; i <= step.a.length; i++) {
        at(t, () => setTyped(step.a.slice(0, i)));
        t += TYPE_MS;
      }
      t += HOLD_MS;
      at(t, () => setLeaving(true));
      t += 230;
      at(t, () => {
        setChips((prev) => [...prev, step]);
        setTyped("");
        setLeaving(false);
      });
      t += 520;
      at(t, () => {
        if (index < ANSWERS.length - 1) setIndex(index + 1);
        else setPhase("reading");
      });
      return clear;
    }

    if (phase === "reading") {
      at(READ_MS, () => setPhase("report"));
      return clear;
    }

    at(REPORT_MS, () => {
      setChips([]);
      setIndex(0);
      setPhase("intake");
    });
    return clear;
  }, [phase, index, still]);

  const step = ANSWERS[index]!;
  const flying = phase === "reading" || phase === "report";

  return (
    <div
      className="morph"
      role="img"
      aria-label="A demonstration: three answers becoming a diagnosis"
    >
      <div className="morph-bar">
        <span className="morph-dot" />
        <span className="morph-title">
          {showReport ? "your first read" : "setting up your profile"}
        </span>
        <span className="morph-meta">
          {showReport ? "3 findings" : `${chips.length} / 27 core`}
        </span>
      </div>

      <div className="morph-stage">
        {/* ── the intake ── */}
        {!still && (
          <div className={`morph-intake ${flying ? "gone" : ""}`}>
            <div className={leaving ? "morph-card leaving" : "morph-card"} key={index}>
              <div className="morph-eyebrow">{step.prov.split(" · ")[0]} · CORE</div>
              <p className="morph-q">{step.q}</p>
              <div className="morph-field">
                <span>{typed}</span>
                <i className="morph-caret" />
              </div>
            </div>
          </div>
        )}

        {/* ── the answers, which then fly into the report ── */}
        {!still && (
          <div className={`morph-chips ${flying ? "fly" : ""}`}>
            {chips.map((c, i) => (
              <div
                className="morph-chip"
                key={`${c.a}-${i}`}
                style={{ transitionDelay: `${i * 90}ms` }}
              >
                <span className="morph-chip-a">{c.a}</span>
                <span className="morph-chip-p">
                  <i className="morph-pip" />
                  {c.prov}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* the profile filling up underneath — the panel's floor, so it is
            never empty while the questions are still being answered */}
        {!still && (
          <div className={`morph-core ${flying ? "gone" : ""}`}>
            <div className="morph-core-meter" aria-hidden="true">
              {Array.from({ length: CORE_TOTAL }, (_, c) => (
                <i
                  key={c}
                  className={c < chips.length ? "on" : c === chips.length ? "cur" : ""}
                  style={{ transitionDelay: `${c * 18}ms` }}
                />
              ))}
            </div>
            <div className="morph-core-row">
              <span className="morph-core-names">
                {CORE_FIELDS.map((n, idx) => (
                  <em key={n} className={idx < chips.length ? "lit" : ""}>
                    {n}
                  </em>
                ))}
                <em className="rest">+{CORE_TOTAL - CORE_FIELDS.length} more</em>
              </span>
              <span className="morph-core-count">
                {chips.length} of {CORE_TOTAL} core
              </span>
            </div>
          </div>
        )}

        {phase === "reading" && <Scanner />}

        {/* ── the instrument cluster those answers produced ── */}
        <div className={`morph-report ${showReport ? "in" : ""}`}>
          <div className="hud-grid">
            <LeakDial value={spaced(leak)} live={showReport} />
            <MarginRadar live={showReport} />
            <div className="hud-side">
              <MiniGauge
                label="real margin"
                value={`${margin}%`}
                note="YOU SAID 40%"
                frac={0.23}
                live={showReport}
              />
              <MiniGauge
                label="per order"
                value="14 516"
                note="COMPUTED"
                frac={0.62}
                tone="blue"
                live={showReport}
              />
            </div>
          </div>
          <p className="morph-finding">
            <strong>Your best seller is your least profitable.</strong> Szörp 0.5L is 61% of what
            you sell and returns the thinnest margin of the five.
          </p>
        </div>
      </div>
    </div>
  );
}
