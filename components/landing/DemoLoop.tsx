"use client";

// A landing-page demo that plays the actual product — P1-55.
//
// Not a video and not a GIF: a real DOM loop, so it stays crisp at any
// size, costs no download, reflows on a phone, and can never drift out
// of date with the interface it is advertising. It runs the true motion
// sequence from the intake (§4.2): a question rises, an answer is typed,
// the card departs, the chip settles into the column carrying its
// provenance line.
//
// Under prefers-reduced-motion it renders the finished state instead of
// animating — the same information, no movement.

import { useEffect, useRef, useState } from "react";

interface Step {
  q: string;
  a: string;
  prov: string;
  dot?: "solid" | "hollow";
}

const STEPS: Step[] = [
  { q: "What is the name of the business?", a: "Szörp Kft.", prov: "1.1 · you told me" },
  {
    q: "About how much does it make in a typical month?",
    a: "≈ 4 500 000 HUF",
    prov: "4.2 · your estimate",
  },
  { q: "What do you sell?", a: "5 products", prov: "3.1 · you told me" },
  {
    q: "What does the 0.5L cost you to make?",
    a: "I don't know",
    prov: "3.4 · gap · will revisit",
    dot: "hollow",
  },
];

const TYPE_MS = 42;
const HOLD_MS = 620;
const SETTLE_MS = 620;
const RESTART_MS = 2100;

export function DemoLoop() {
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState("");
  const [chips, setChips] = useState<Step[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [still, setStill] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStill(true);
      setChips(STEPS);
      setTyped(STEPS[STEPS.length - 1]!.a);
      setIndex(STEPS.length - 1);
    }
  }, []);

  useEffect(() => {
    if (still) return;
    const at = (ms: number, fn: () => void): void => {
      timers.current.push(setTimeout(fn, ms));
    };
    const step = STEPS[index]!;
    let t = 420; // the card rises before anything is typed

    for (let i = 1; i <= step.a.length; i++) {
      at(t, () => setTyped(step.a.slice(0, i)));
      t += TYPE_MS;
    }
    t += HOLD_MS;
    at(t, () => setLeaving(true)); // the answer departs (§4.2)
    t += 240;
    at(t, () => {
      setChips((prev) => [...prev, step]);
      setTyped("");
      setLeaving(false);
    });
    t += SETTLE_MS;
    at(t, () => {
      if (index < STEPS.length - 1) {
        setIndex(index + 1);
      } else {
        timers.current.push(
          setTimeout(() => {
            setChips([]);
            setIndex(0);
          }, RESTART_MS),
        );
      }
    });

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [index, still]);

  const step = STEPS[index]!;

  return (
    <div className="demo" aria-label="A short demonstration of the intake" role="img">
      <div className="demo-bar">
        <span className="demo-dot" />
        <span className="demo-meta">
          {chips.length} / 27 core
        </span>
      </div>

      <div className="demo-body">
        <div className={leaving ? "demo-card leaving" : "demo-card"} key={index}>
          <div className="demo-eyebrow">{step.prov.split(" · ")[0]} · CORE</div>
          <p className="demo-q">{step.q}</p>
          <div className="demo-field">
            <span>{still ? step.a : typed}</span>
            {!still && <i className="demo-caret" />}
          </div>
        </div>

        <div className="demo-chips">
          {chips.map((c, i) => (
            <div className="demo-chip" key={`${c.q}-${i}`}>
              <span className="demo-chip-q">{c.q}</span>
              <span className="demo-chip-a">{c.a}</span>
              <span className="demo-chip-p">
                <i className={c.dot === "hollow" ? "demo-pip hollow" : "demo-pip"} />
                {c.prov}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
