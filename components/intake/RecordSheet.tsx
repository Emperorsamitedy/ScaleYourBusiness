"use client";

// The record card (owner design intake-v2): what is on file for the area
// being asked, newest first — each row its value right-aligned in mono and
// its basis, a named class from what produced the fact
// (components/report/basis.ts), never a percentage. The rows are the
// server's (lib/intake/record-view.ts areaRecord); this component re-words
// them and prints figures through components/sheet/num.ts.
//
// The newest row carries the marker when it was just laid down. A row
// that came from a question can be changed (P0-75): a reason is asked and
// the question returns to the left; the old value stays in history.
//
// Below, WHAT THIS ANSWER UNLOCKS lists the bank's own `unlocks` for the
// question being asked, each OPEN when it already applies to this
// business and LOCKED when its condition does not hold yet.
//
// The design's CONFIRM button is not drawn: nothing in the record has an
// "imported, awaiting confirmation" status for it to act on.

import { useState } from "react";
import type { AreaRecord, IntakeUnlock, RecordFact } from "@/lib/intake/types";
import { areaName, basisWord, factLabel, factValue, sourceWord } from "./record";
import { num } from "../sheet/num";

function ChangeRow({
  fact,
  onReopen,
  onAsk,
  onClose,
}: {
  fact: RecordFact;
  onReopen: (questionId: string, reason: string) => void;
  onAsk: (questionId: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const qid = fact.question_id;
  if (!qid) return null;
  const inputId = `ix-reason-${qid}`;
  if (fact.status === "skipped") {
    return (
      <li className="ix-change">
        <span className="ix-note">Skipped earlier — it can be answered now.</span>
        <button type="button" className="act" onClick={() => onAsk(qid)}>
          Answer it now &rarr;
        </button>
        <button type="button" className="ix-link" onClick={onClose}>
          Keep it skipped
        </button>
      </li>
    );
  }
  return (
    <li className="ix-change">
      <form
        className="ix-change-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim() === "") return;
          onReopen(qid, reason.trim());
        }}
      >
        <label className="ix-cap" htmlFor={inputId}>
          What changed?
        </label>
        <input
          id={inputId}
          className="ix-input"
          type="text"
          autoComplete="off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. the price went up in March"
        />
        <button type="submit" className="act" disabled={reason.trim() === ""}>
          Change this answer &rarr;
        </button>
        <button type="button" className="ix-link" onClick={onClose}>
          Leave it
        </button>
      </form>
    </li>
  );
}

export function RecordSheet({
  area,
  channel,
  unlocks,
  freshKey,
  flagged,
  onReopen,
  onAsk,
}: {
  area: AreaRecord;
  channel: string | null;
  unlocks: readonly IntakeUnlock[];
  /** The key of the row just laid down, for the marker. */
  freshKey: string | null;
  /** Question ids involved in an open finding. */
  flagged: ReadonlySet<string>;
  onReopen: (questionId: string, reason: string) => void;
  onAsk: (questionId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const title = `${channel ? `Channel ${channel} · ` : ""}${areaName(area.section)}`;

  return (
    <section className="ix-card ix-rec" aria-labelledby="ix-rec-h">
      <header className="ix-card-head">
        <p className="ix-cap">The record · newest first</p>
        <div className="ix-card-titlerow">
          <h2 className="ix-card-title" id="ix-rec-h">
            {title}
          </h2>
          <span className="ix-note">
            <span className="fig">{num(area.fact_count)}</span>{" "}
            {area.fact_count === 1 ? "fact" : "facts"}
          </span>
        </div>
      </header>

      {area.facts.length === 0 ? (
        <p className="ix-rec-empty">
          Nothing on file in this area yet. Each answer lands here with where it came from.
        </p>
      ) : (
        <ul className="ix-rec-list" aria-label={`Facts on file in ${areaName(area.section)}`}>
          {area.facts.map((fact) => {
            const value = factValue(fact);
            const label = factLabel(fact);
            const changeable =
              fact.question_id !== null &&
              (fact.status === "answered" ||
                fact.status === "unknown" ||
                fact.status === "skipped");
            const rowKey = `${fact.key}@${fact.recorded_at}`;
            const isOpen = open === rowKey;
            const isFlagged = fact.question_id !== null && flagged.has(fact.question_id);
            const gap = fact.status === "unknown" || fact.status === "skipped";
            return (
              <li key={rowKey} className="ix-rec-item">
                <div
                  className={["ix-rec-row", fact.key === freshKey ? "fresh" : "", gap ? "gap" : ""]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="ix-rec-name">
                    {changeable ? (
                      <button
                        type="button"
                        className="ix-fact-btn"
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : rowKey)}
                      >
                        {label}
                        <span className="sr-only">
                          {fact.status === "skipped" ? " — answer it now" : " — change this answer"}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                    <span className="ix-rec-src">{sourceWord(fact)}</span>
                  </span>
                  <span
                    className={value.figure ? "ix-rec-val fig" : "ix-rec-val"}
                    title={value.full}
                  >
                    {value.text}
                  </span>
                  <span className="ix-rec-basis">
                    {basisWord(fact)}
                    {isFlagged && <span className="flag drift">to reconcile</span>}
                  </span>
                </div>
                {isOpen && changeable && (
                  <ul className="ix-change-wrap">
                    <ChangeRow
                      fact={fact}
                      onReopen={(id, reason) => {
                        setOpen(null);
                        onReopen(id, reason);
                      }}
                      onAsk={(id) => {
                        setOpen(null);
                        onAsk(id);
                      }}
                      onClose={() => setOpen(null)}
                    />
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {area.fact_count > area.facts.filter((f) => f.text !== null).length && (
        <p className="ix-more">
          The rest is on <a href="/profile">the fact sheet</a>
        </p>
      )}

      {unlocks.length > 0 && (
        <div className="ix-unlocks">
          <h3 className="ix-cap">What this answer unlocks</h3>
          <ul>
            {unlocks.map((u) => (
              <li key={u.id} className="ix-unlock">
                <span className="ix-unlock-text">
                  <span className="ix-unlock-id fig">Q {u.id}</span> {u.prompt}
                </span>
                <span className={u.open ? "ix-badge open" : "ix-badge"}>
                  {u.open ? "Open" : "Locked"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
