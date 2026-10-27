"use client";

// The channel bank (owner design intake-v2): one tile per bank section
// that applies to this business, numbered CH 01…, with the share of its
// questions answered and a stack of thin bars — one per applicable
// question, as the server computed them (lib/intake/areas.ts areaBars):
//
//   owner     solid paper     the owner answered it
//   measured  diagonal hatch  read from a connection
//   derived   dotted paper    worked out from other facts (rule 6)
//   current   cobalt          the question being asked now
//   open      thin outline    not asked yet
//   unknown   dashed outline  an explicit "I don't know" (rule 5)
//   skipped   half height     skipped for now — distinct from both
//
// The status word re-words the server's area status. A tile with
// something to ask is a button: choosing it asks that area's next
// question (preferSection on the server).
//
// The bank starts folded to one line — the channel being asked, a strip
// of every area's progress, how many are done — so the question owns the
// screen. Unfolding shows the tiles unchanged; choosing one folds it again.

import { useEffect, useId, useRef, useState } from "react";
import type { IntakeArea } from "@/lib/intake/types";
import {
  areaAskable,
  areaName,
  areaPercent,
  areaStatusWord,
  bankSummary,
  channelNo,
  tileColumns,
} from "./record";

const BAR_WORD: Record<IntakeArea["bars"][number], string> = {
  owner: "from you",
  measured: "measured",
  derived: "worked out",
  current: "asking now",
  open: "open",
  unknown: "not known",
  skipped: "skipped",
};

/** "6 from you, 2 measured, 1 open" — the bars in words, for a screen reader. */
function barsInWords(bars: IntakeArea["bars"]): string {
  const counts = new Map<string, number>();
  for (const b of bars) counts.set(BAR_WORD[b], (counts.get(BAR_WORD[b]) ?? 0) + 1);
  return [...counts.entries()].map(([w, n]) => `${n} ${w}`).join(", ");
}

export function AreaTiles({
  areas,
  active,
  busy,
  connector,
  onChoose,
}: {
  areas: readonly IntakeArea[];
  active: string | null;
  busy: boolean;
  /** The legend's connector name (connectorLegend). */
  connector: string;
  onChoose: (section: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tilesId = useId();
  // When the bank scrolls inside itself, keep the active tile in view by
  // scrolling the strip — never the page.
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const li = activeRef.current;
    const strip = li?.parentElement;
    if (!li || !strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = li.offsetLeft - strip.offsetLeft - 16;
  }, [active, open]);
  if (areas.length === 0) return null;

  const channelOf = (section: string): string | null => {
    const i = areas.findIndex((a) => a.section === section);
    return i < 0 ? null : channelNo(i);
  };
  const summary = bankSummary(areas, active);

  return (
    <nav className={open ? "ix-bank open" : "ix-bank"} aria-labelledby="ix-bank-h">
      <h2 className="ix-cap" id="ix-bank-h">
        <button
          type="button"
          className="ix-bank-fold"
          aria-expanded={open}
          aria-controls={tilesId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ix-bank-title">Channel bank</span>
          <span className="ix-bank-now">
            {summary.current ? (
              <>
                CH {summary.current.ch} · {summary.current.name} ·{" "}
                <span className="fig">{summary.current.pct}%</span>
              </>
            ) : (
              "Your business, measured area by area"
            )}
          </span>
          <span className="ix-bank-strip" aria-hidden="true">
            {areas.map((a) => (
              <span
                key={a.section}
                className={a.section === active ? "ix-bank-cell live" : "ix-bank-cell"}
              >
                <span style={{ width: `${areaPercent(a)}%` }} />
              </span>
            ))}
          </span>
          <span className="ix-bank-done">
            <span className="fig">{summary.done}</span> of {summary.total} done
          </span>
          <span className="ix-bank-toggle">{open ? "Hide channels" : "All channels"}</span>
        </button>
      </h2>
      {open && (
        <p className="ix-cap ix-legend">
          <span className="ix-key-sw owner" aria-hidden="true" /> from you{" "}
          <span className="ix-key-sw measured" aria-hidden="true" /> read from {connector} · any
          order is fine
        </p>
      )}
      <ol
        id={tilesId}
        hidden={!open}
        className="ix-tiles"
        style={{ "--tile-cols": tileColumns(areas.length) } as React.CSSProperties}
      >
        {areas.map((area, i) => {
          const isActive = area.section === active;
          const status = areaStatusWord(area, { active: isActive, channelOf });
          const askable = areaAskable(area) && !isActive;
          const pct = areaPercent(area);
          const name = areaName(area.section);
          const body = (
            <>
              <span className="ix-tile-top">
                <span>CH {channelNo(i)}</span>
                <span className="fig">{pct}%</span>
              </span>
              <span className="ix-bars" aria-hidden="true">
                {area.bars.map((b, j) => (
                  <span key={j} className={`ix-bar ${b}`} />
                ))}
              </span>
              <span className="ix-tile-name">{name}</span>
              <span className={`ix-tile-status${status.tone ? ` ${status.tone}` : ""}`}>
                {status.word}
              </span>
            </>
          );
          const words = `Channel ${channelNo(i)}, ${name}: ${status.word}, ${pct}% answered — ${barsInWords(area.bars)}.`;
          return (
            <li key={area.section} ref={isActive ? activeRef : undefined}>
              {askable ? (
                <button
                  type="button"
                  className="ix-tile"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    onChoose(area.section);
                  }}
                  aria-label={`${words} Ask from this area.`}
                >
                  {body}
                </button>
              ) : (
                <div
                  className={isActive ? "ix-tile active" : "ix-tile still"}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={words}
                  role="group"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
