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
//
// Decluttered 2026-11-09 on the owner's instruction: no "The record ·
// newest first" caption, and the empty line is one sentence.

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AreaRecord, IntakeUnlock, RecordFact } from "@/lib/intake/types";
import { areaName, basisWord, factLabel, factValue, sourceWord } from "./record";
import { useIntakeWords } from "./words";

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
  const t = useTranslations("intake.record");
  const qid = fact.question_id;
  if (!qid) return null;
  const inputId = `ix-reason-${qid}`;
  if (fact.status === "skipped") {
    return (
      <li className="ix-change">
        <span className="ix-note">{t("skippedEarlier")}</span>
        <button type="button" className="act" onClick={() => onAsk(qid)}>
          {t("answerNow")} &rarr;
        </button>
        <button type="button" className="ix-link" onClick={onClose}>
          {t("keepSkipped")}
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
          {t("whatChanged")}
        </label>
        <input
          id={inputId}
          className="ix-input"
          type="text"
          autoComplete="off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("whatChangedExample")}
        />
        <button type="submit" className="act" disabled={reason.trim() === ""}>
          {t("change")} &rarr;
        </button>
        <button type="button" className="ix-link" onClick={onClose}>
          {t("leave")}
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
  const t = useTranslations("intake.record");
  const tq = useTranslations("intake.question");
  const { tr, locale } = useIntakeWords();
  const fig = (chunks: ReactNode) => <span className="fig">{chunks}</span>;
  const name = areaName(area.section, tr);
  const title = channel ? t("channelTitle", { channel, area: name }) : name;

  return (
    <section className="ix-card ix-rec" aria-labelledby="ix-rec-h">
      <header className="ix-card-head">
        <div className="ix-card-titlerow">
          <h2 className="ix-card-title" id="ix-rec-h">
            {title}
          </h2>
          <span className="ix-note">{t.rich("facts", { count: area.fact_count, fig })}</span>
        </div>
      </header>

      {area.facts.length === 0 ? (
        <p className="ix-rec-empty">{t("empty")}</p>
      ) : (
        <ul className="ix-rec-list" aria-label={t("listLabel", { area: name })}>
          {area.facts.map((fact) => {
            const value = factValue(fact, tr, locale);
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
                          {", "}
                          {fact.status === "skipped" ? t("srAnswer") : t("srChange")}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                    <span className="ix-rec-src">{sourceWord(fact, tr)}</span>
                  </span>
                  <span
                    className={value.figure ? "ix-rec-val fig" : "ix-rec-val"}
                    title={value.full}
                  >
                    {value.text}
                  </span>
                  <span className="ix-rec-basis">
                    {basisWord(fact, tr)}
                    {isFlagged && <span className="flag drift">{t("toReconcile")}</span>}
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
          {t.rich("rest", { a: (chunks) => <a href="/profile">{chunks}</a> })}
        </p>
      )}

      {unlocks.length > 0 && (
        <div className="ix-unlocks">
          <h3 className="ix-cap">{t("unlocks")}</h3>
          <ul>
            {unlocks.map((u) => (
              <li key={u.id} className="ix-unlock">
                <span className="ix-unlock-text">
                  <span className="ix-unlock-id">{tq.rich("ref", { id: u.id, fig })}</span>{" "}
                  {u.prompt}
                </span>
                <span className={u.open ? "ix-badge open" : "ix-badge"}>
                  {u.open ? t("open") : t("locked")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
