// The live reading card (owner design intake-v2, right column): one
// derived figure from lib/economics on the current records, drawn as a
// semicircle dial — plain SVG arcs, no gradients — with the value as a big
// mono figure and an ink needle.
//
// The design's coloured bands ("normal 45–60 %", "act now below 40 %")
// and its ACT NOW · BELOW flag need a reference range. None exists in the
// data — no benchmark and no margin target in the owner's goals — so the
// track is neutral and the card says "no reference range yet". When the
// owner stated a margin of their own, it is marked on the dial as theirs.
// The card is not drawn at all when no figure can be computed.

import type { LiveReading as Reading } from "@/lib/intake/types";
import { dialPoint, readinessCells } from "./record";
import { num } from "../sheet/num";

const CX = 110;
const CY = 108;
const R = 88;
/** Labelled scale points on the 0–100 dial. */
const LABELS = [0, 50, 100];

function arc(from: number, to: number, r: number): string {
  const a = dialPoint(from, CX, CY, r);
  const b = dialPoint(to, CX, CY, r);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function LiveReading({ reading }: { reading: Reading }) {
  const tip = dialPoint(reading.value_pct, CX, CY, R - 20);
  const ticks = Array.from({ length: 21 }, (_, i) => i * 5);
  const stated = reading.stated_pct;
  const statedAt = stated !== null ? dialPoint(stated, CX, CY, R + 9) : null;
  return (
    <section className="ix-card" aria-labelledby="ix-live-h">
      <header className="ix-card-head">
        <p className="ix-cap">Live reading · moves as you answer</p>
        <h2 className="ix-card-title" id="ix-live-h">
          {reading.label}
        </h2>
      </header>
      <div className="ix-live">
        <svg
          className="ix-dial"
          viewBox="0 0 220 128"
          role="img"
          aria-label={`${reading.label} ${num(reading.value_pct, 1)} percent on a 0 to 100 dial${
            stated !== null ? `; you stated ${num(stated, 1)} percent` : ""
          }`}
        >
          <path className="ix-dial-track" d={arc(0, 100, R)} />
          {ticks.map((t) => {
            const a = dialPoint(t, CX, CY, R - 9);
            const b = dialPoint(t, CX, CY, R - (t % 25 === 0 ? 19 : 14));
            return (
              <line
                key={t}
                className={t % 25 === 0 ? "ix-dial-tick major" : "ix-dial-tick"}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}
          {LABELS.map((t) => {
            const p = dialPoint(t, CX, CY, R + 4);
            return (
              <text
                key={t}
                className="ix-dial-label"
                x={t === 50 ? p.x : t === 0 ? p.x + 2 : p.x - 2}
                y={t === 50 ? p.y - 5 : p.y + 16}
                textAnchor={t === 0 ? "start" : t === 100 ? "end" : "middle"}
              >
                {t}
              </text>
            );
          })}
          {statedAt && <circle className="ix-dial-stated" cx={statedAt.x} cy={statedAt.y} r={4} />}
          <line className="ix-dial-needle" x1={CX} y1={CY} x2={tip.x} y2={tip.y} />
          <rect className="ix-dial-hub" x={CX - 7} y={CY - 7} width={14} height={14} />
        </svg>
        <div className="ix-live-fig">
          <p className="ix-big fig">
            {num(reading.value_pct, 1)} <span className="ix-big-unit">%</span>
          </p>
          <p className="ix-note">no reference range yet</p>
          {stated !== null && (
            <p className="ix-note">
              <span className="ix-stated-sw" aria-hidden="true" /> you stated{" "}
              <span className="fig">{num(stated, 1)} %</span>
            </p>
          )}
        </div>
      </div>
      <p className="ix-card-foot ix-note">
        <strong>Derived</strong> · {reading.formula} · from{" "}
        <span className="fig">{reading.inputs}</span> recorded{" "}
        {reading.inputs === 1 ? "fact" : "facts"}
      </p>
    </section>
  );
}

export function Readiness({ fraction }: { fraction: number }) {
  const cells = 25;
  const filled = readinessCells(fraction, cells);
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <section className="ix-card" aria-labelledby="ix-ready-h">
      <header className="ix-card-head row">
        <h2 className="ix-cap" id="ix-ready-h">
          Report readiness
        </h2>
        <p className="ix-ready-pct fig">{pct} %</p>
      </header>
      <div
        className="ix-cells"
        role="meter"
        aria-labelledby="ix-ready-h"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className={i < filled ? "ix-cell on" : "ix-cell"} />
        ))}
      </div>
      <p className="ix-note">each answer narrows the ranges in your report</p>
    </section>
  );
}
