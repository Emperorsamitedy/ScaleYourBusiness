"use client";

// The hero's product walkthrough — a 36-second "video" drawn live from
// lib/marketing/walkthrough.ts: six chapters, a gliding cursor, captions,
// a play/pause button and a chapter list, as the owner's landing design
// (2026-10-17) sets it. Under prefers-reduced-motion it opens paused on
// the report, exactly as the design does; the visitor can still press
// play. Nothing is sent anywhere — the clock is component state. The
// business on screen is the demo the visitor picked (./Demos): the
// webshop by default, or the salon; switching keeps the clock.

import { useEffect, useState, type CSSProperties } from "react";
import { moneyText, num } from "../sheet/num";
import type { SampleRecordRow } from "../../lib/marketing/sample-diagnosis";
import {
  CHAPTERS,
  REDUCED_MOTION_SECOND,
  SCENE_SECONDS,
  TICK_MS,
  WALK_SECONDS,
  frame,
} from "../../lib/marketing/walkthrough";
import { useDemo } from "./Demos";

const TOTAL_TICKS = WALK_SECONDS * 10;
const pressed: CSSProperties = { background: "#F3DF4E", color: "#132119" };
const FLAG_COLOR = { ACT: "#A3261B", HIGH: "#8A5300", LOW: "#8A5300", OK: "#2E6B47" } as const;
/** "1.4", "11" — a whole figure prints whole. */
const pct = (v: number) => (Number.isInteger(v) ? num(v) : num(v, 1));

export function Walkthrough() {
  const { sample } = useDemo();
  const eur = (minor: number) => moneyText(minor, sample.currency);
  const figure = (f: SampleRecordRow["figure"]) =>
    "count" in f ? num(f.count) : "money_minor" in f ? eur(f.money_minor) : f.words;
  // Tenths of a second, so the clock never drifts on float addition.
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // no matchMedia: play as designed
    }
    if (reduce) {
      setPlaying(false);
      setTick(REDUCED_MOTION_SECOND * 10);
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTick((t) => (t + 1) % TOTAL_TICKS), TICK_MS);
    return () => clearInterval(id);
  }, [playing]);

  const t = tick / 10;
  const f = frame(t, sample);
  const chap = CHAPTERS[f.scene] ?? CHAPTERS[0]!;

  return (
    <figure className="ll-player" aria-label="Product walkthrough video">
      <div className="ll-vbar">
        <span className="ll-m" style={{ fontSize: 11, letterSpacing: ".12em", color: "#A9BDB2" }}>
          SYB · PRODUCT WALKTHROUGH
        </span>
        <span className="ll-m" style={{ fontSize: 11, color: "#A9BDB2" }}>
          Chapter {f.scene + 1} of 6 · {chap.title}
        </span>
      </div>

      <div className="ll-screen">
        <div className="ll-appbar">
          <span className="ll-s" style={{ fontWeight: 700, fontSize: 14 }}>
            SYB
          </span>
          <span className="ll-m" style={{ fontSize: 10.5, color: "#3E5248" }}>
            {chap.crumb}
          </span>
          <span className="ll-m" style={{ fontSize: 10.5, marginLeft: "auto", color: "#1F4FD1" }}>
            ● {chap.state}
          </span>
        </div>
        <div
          className="ll-stage"
          role="img"
          aria-label={`Walkthrough with an illustrative ${sample.noun}, chapter ${f.scene + 1}: ${chap.caption}`}
        >
          {f.scene === 0 && (
            <div className="ll-sc" key={`s1-${sample.id}`}>
              <div className="ll-k" style={{ color: "#3E5248" }}>
                Step 1 · Connect
              </div>
              <div className="ll-s" style={{ fontSize: 26, fontWeight: 600, marginTop: 6 }}>
                Connect your accounts, read-only.
              </div>
              <div className="ll-mini-card" style={{ marginTop: 16, maxWidth: 420 }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span className="ll-s" style={{ fontSize: 17, fontWeight: 600 }}>
                    {sample.connect.source}
                  </span>
                  <span className="ll-m ll-tagg">READ-ONLY</span>
                </div>
                <div
                  className="ll-m"
                  style={{ fontSize: 12, color: "#3E5248", marginTop: 8, lineHeight: 1.7 }}
                >
                  {sample.connect.reads}
                </div>
                {f.connect.done ? (
                  <>
                    <div
                      className="ll-m"
                      style={{ fontSize: 12.5, color: "#2E6B47", fontWeight: 600, marginTop: 14 }}
                    >
                      ✓ Connected · reading 12 months
                    </div>
                    <div style={{ height: 6, background: "rgba(19,33,25,.12)", marginTop: 8 }}>
                      <div
                        style={{
                          height: "100%",
                          background: "#2E6B47",
                          width: `${f.connect.bar.toFixed(1)}%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="ll-vbtn" style={f.connect.pressed ? pressed : undefined}>
                    Connect →
                  </div>
                )}
              </div>
            </div>
          )}

          {f.scene === 1 && (
            <div className="ll-sc" key={`s2-${sample.id}`} style={{ display: "flex", gap: 18 }}>
              <div style={{ flex: "3 1 0", minWidth: 0 }}>
                <div className="ll-k" style={{ color: "#3E5248" }}>
                  Step 2 · A few questions
                </div>
                <div
                  className="ll-s"
                  style={{ fontSize: 22, fontWeight: 600, marginTop: 6, lineHeight: 1.15 }}
                >
                  {sample.record.question}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: 6,
                    marginTop: 16,
                  }}
                >
                  {sample.record.options.map((label, i) => {
                    const mine = i === sample.record.picked;
                    const style: CSSProperties =
                      mine && f.question.picked
                        ? { background: "#132119", color: "#F2F7F4" }
                        : mine && f.question.hovered
                          ? { background: "#DFE9E3" }
                          : { background: "#FFFFFF" };
                    return (
                      <div key={label} className="ll-opt" style={style}>
                        {label}
                      </div>
                    );
                  })}
                </div>
                <div className="ll-m" style={{ fontSize: 11, color: "#3E5248", marginTop: 10 }}>
                  A range is enough.
                </div>
              </div>
              <div
                className="ll-s2-rec"
                style={{
                  flex: "2 1 0",
                  minWidth: 0,
                  borderLeft: "1px solid rgba(19,33,25,.2)",
                  paddingLeft: 14,
                }}
              >
                <div className="ll-k" style={{ color: "#3E5248" }}>
                  The record
                </div>
                {f.question.fact && (
                  <div className="ll-m ll-slidein ll-rec-row">
                    <span className="ll-mark">{sample.record.fact}</span> · you
                  </div>
                )}
                {sample.record.rows.map((r, i) => (
                  <div
                    key={r.what}
                    className="ll-m ll-rec-row"
                    style={i === sample.record.rows.length - 1 ? { borderBottom: 0 } : undefined}
                  >
                    {r.what} · {figure(r.figure)} · {r.source}
                  </div>
                ))}
              </div>
            </div>
          )}

          {f.scene === 2 && (
            <div className="ll-sc" key={`s3-${sample.id}`}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 12,
                }}
              >
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Step 3 · The watch
                  </div>
                  <div className="ll-s" style={{ fontSize: 26, fontWeight: 600, marginTop: 6 }}>
                    We read. Nothing is touched.
                  </div>
                </div>
                <span className="ll-m ll-tagg" style={{ color: "#1F4FD1", borderColor: "#1F4FD1" }}>
                  WATCHING
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(14, minmax(0, 1fr))",
                  gap: 3,
                  marginTop: 18,
                }}
              >
                {Array.from({ length: 28 }, (_, d) => (
                  <div
                    key={d}
                    style={
                      d < f.watch.filled
                        ? { height: 22, background: "#132119" }
                        : d === f.watch.filled
                          ? { height: 22, background: "#1F4FD1" }
                          : { height: 22, border: "1px solid rgba(19,33,25,.25)" }
                    }
                  />
                ))}
              </div>
              <div className="ll-s3-stats">
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Day
                  </div>
                  <div className="ll-m ll-s3-fig">{f.watch.day} / 28</div>
                </div>
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Readings
                  </div>
                  <div className="ll-m ll-s3-fig">{num(f.watch.readings)}</div>
                </div>
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Changes made
                  </div>
                  <div className="ll-m ll-s3-fig">0</div>
                </div>
              </div>
            </div>
          )}

          {f.scene === 3 && (
            <div className="ll-sc" key={`s4-${sample.id}`}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Step 4 · Your report
                  </div>
                  <div className="ll-s" style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>
                    Every leak, priced.
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Leak / month
                  </div>
                  <div className="ll-s" style={{ fontSize: 26, fontWeight: 700, color: "#A3261B" }}>
                    {f.report.total
                      ? `${eur(f.report.total.low_minor)}–${eur(f.report.total.high_minor)}`
                      : "€ —"}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                {sample.markers.map((r, i) => {
                  const vis = i < f.report.shown;
                  const pc = (q: number) => ((q - r.scale[0]) / (r.scale[1] - r.scale[0])) * 100;
                  return (
                    <div key={r.measure} className="ll-s4row" style={{ opacity: vis ? 1 : 0.35 }}>
                      <span style={{ fontSize: 12.5 }}>{r.measure}</span>
                      <div className="ll-rbar">
                        <div className="ll-rbar-base" />
                        <div
                          className="ll-rbar-band"
                          style={{
                            left: `${pc(r.range[0])}%`,
                            width: `${pc(r.range[1]) - pc(r.range[0])}%`,
                          }}
                        />
                        {vis && (
                          <div className="ll-rbar-tick" style={{ left: `${pc(r.value)}%` }} />
                        )}
                      </div>
                      <span
                        className="ll-m"
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          textAlign: "right",
                          color: FLAG_COLOR[r.flag],
                        }}
                      >
                        {vis ? r.flag : ""}
                      </span>
                      <span className="ll-m" style={{ fontSize: 11, textAlign: "right" }}>
                        {vis ? (r.leak_minor === null ? "—" : eur(r.leak_minor)) : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {f.scene === 4 && (
            <div className="ll-sc" key={`s5-${sample.id}`}>
              <div className="ll-k" style={{ color: "#3E5248" }}>
                Step 5 · You decide
              </div>
              <div className="ll-mini-card" style={{ marginTop: 10, position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span className="ll-m" style={{ fontSize: 11, color: "#3E5248" }}>
                    Proposal · {sample.proposal.area}
                  </span>
                  <span
                    className="ll-m"
                    style={{ fontSize: 11, color: "#2E6B47", fontWeight: 600 }}
                  >
                    RECOMMENDED
                  </span>
                </div>
                <div
                  className="ll-s"
                  style={{ fontSize: 21, fontWeight: 600, marginTop: 6, lineHeight: 1.15 }}
                >
                  {sample.proposal.title}
                </div>
                <div className="ll-s5-figs">
                  <div>
                    <div className="ll-k" style={{ color: "#3E5248" }}>
                      Expected
                    </div>
                    <div className="ll-m" style={{ fontSize: 16, fontWeight: 600 }}>
                      +{eur(sample.proposal.expected_low_minor)}–
                      {eur(sample.proposal.expected_high_minor)} / mo
                    </div>
                  </div>
                  <div>
                    <div className="ll-k" style={{ color: "#3E5248" }}>
                      Undo
                    </div>
                    <div className="ll-m" style={{ fontSize: 16, fontWeight: 600 }}>
                      Any time
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <div className="ll-vbtn" style={f.approve.pressed ? pressed : undefined}>
                    Approve →
                  </div>
                  <div className="ll-vbtn" style={{ background: "transparent", color: "#132119" }}>
                    Decline
                  </div>
                </div>
                {f.approve.approved && <div className="ll-stampv">APPROVED · runs 15:00</div>}
              </div>
            </div>
          )}

          {f.scene === 5 && (
            <div className="ll-sc" key={`s6-${sample.id}`}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Step 6 · Measured
                  </div>
                  <div className="ll-s" style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>
                    See exactly what it earned.
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="ll-k" style={{ color: "#3E5248" }}>
                    Recovered / month
                  </div>
                  <div className="ll-s" style={{ fontSize: 28, fontWeight: 700, color: "#26A69A" }}>
                    +{eur(f.results.recovered_minor)}
                  </div>
                </div>
              </div>
              <svg viewBox="0 0 600 150" className="ll-s6-svg" aria-hidden="true">
                <path d="M0 37H600M0 75H600M0 112H600" stroke="#E0E3EB" strokeDasharray="2 3" />
                <line x1="300" y1="0" x2="300" y2="150" stroke="#2962FF" strokeDasharray="3 3" />
                <rect x="292" y="4" width="16" height="16" fill="#2962FF" />
                <text x="300" y="16" textAnchor="middle" fontSize="10" fill="#fff" fontWeight="600">
                  A
                </text>
                <path d={f.results.up} fill="#26A69A" />
                <path d={f.results.down} fill="#EF5350" />
              </svg>
              <div className="ll-m ll-s6-legend">
                <span>
                  Before · {sample.outcome.metric} {pct(sample.outcome.before)} %
                </span>
                <span style={{ color: "#2962FF" }}>A = approved</span>
                <span>
                  After ·{" "}
                  {f.results.metric === null
                    ? "measuring…"
                    : `${sample.outcome.metric} ${num(f.results.metric, 1)} %`}
                </span>
              </div>
            </div>
          )}

          {f.cursor && (
            <div
              className="ll-cursor"
              style={{ left: `${f.cursor.x.toFixed(2)}%`, top: `${f.cursor.y.toFixed(2)}%` }}
              aria-hidden="true"
            >
              <svg viewBox="0 0 20 24" width="20" height="24">
                <path
                  d="M2 1 L2 19 L7 14.5 L10.5 22 L13.5 20.6 L10 13.2 L16.5 13 Z"
                  fill="#132119"
                  stroke="#FFFFFF"
                  strokeWidth="1.4"
                />
              </svg>
            </div>
          )}
          {f.ripple && (
            <div
              className="ll-ripple"
              style={{
                left: `${f.ripple.x.toFixed(2)}%`,
                top: `${f.ripple.y.toFixed(2)}%`,
                opacity: Number(f.ripple.opacity.toFixed(2)),
                transform: `scale(${f.ripple.scale.toFixed(2)})`,
              }}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="ll-caption" aria-live="polite">
          {chap.caption}
        </div>
      </div>

      <div className="ll-controls">
        <button
          type="button"
          className="ll-pbtn"
          onClick={() => setPlaying((v) => !v)}
          aria-label={playing ? "Pause walkthrough" : "Play walkthrough"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="ll-track" aria-hidden="true">
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              background: "#F3DF4E",
              width: `${((t / WALK_SECONDS) * 100).toFixed(2)}%`,
            }}
          />
          {[1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                top: -3,
                width: 2,
                height: 10,
                background: "#0B140F",
                left: `${((i / 6) * 100).toFixed(2)}%`,
              }}
            />
          ))}
        </div>
        <span className="ll-m" style={{ fontSize: 11.5, color: "#A9BDB2", whiteSpace: "nowrap" }}>
          0:{String(Math.floor(t)).padStart(2, "0")} / 0:{WALK_SECONDS}
        </span>
      </div>
      <div className="ll-chaps" role="group" aria-label="Chapters">
        {CHAPTERS.map((c, i) => (
          <button
            key={c.n}
            type="button"
            className={i === f.scene ? "ll-chap on" : "ll-chap"}
            onClick={() => {
              setTick(i * SCENE_SECONDS * 10);
              setPlaying(true);
            }}
            aria-pressed={i === f.scene}
          >
            <span className="ll-m" style={{ opacity: 0.6 }}>
              {c.n}
            </span>{" "}
            {c.title}
          </button>
        ))}
      </div>
      <figcaption className="ll-m" style={{ fontSize: 10.5, color: "#6F8577", marginTop: 8 }}>
        Demo with an illustrative {sample.noun}. Your numbers will be your own.
      </figcaption>
    </figure>
  );
}
