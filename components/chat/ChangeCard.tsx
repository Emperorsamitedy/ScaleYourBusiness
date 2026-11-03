"use client";

// The change card — feature 33, "the assistant acts". Under the reply that
// drafted it: the change in plain words, what is set now beside what it
// would become, and two answers of equal weight, set apart — make the
// change, or open the exact section to change it by hand and see what is
// already there. Nothing is written until the first is pressed; the
// assistant never says "done" before it is (the reply says "drafted").
// Cobalt appears only while the change is genuinely being made.
//
// L-3c: the card's frame is the "chat" catalogue; the change's own words
// (summary, values, the screen's name, the button, the result) are built
// on the server and shown as they are (L-4).

import { useState } from "react";
import Link from "next/link";
import { useTr } from "../sheet/useTr";
import type { ChangeCardView } from "./chat-view";
import { canConfirm, cardFlag, cardKicker } from "./chat-view";

/** The summary as a sentence: one full stop, never two. */
const sentence = (s: string) => (/[.!?”"]$/.test(s) ? s : `${s}.`);

export function ChangeCard({
  card,
  onChanged,
}: {
  card: ChangeCardView;
  onChanged: (card: ChangeCardView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tr } = useTr("chat");
  const flag = cardFlag(card, tr);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", change_id: card.id }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        change?: ChangeCardView;
        error?: string;
      };
      if (res.ok && j.change) onChanged(j.change);
      else setError(j.error ?? tr("change.failed"));
    } catch {
      setError(tr("change.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ak-change inset" aria-label={tr("change.aria")}>
      <p className="ak-change-k">{cardKicker(card, tr)}</p>
      <p className="ak-change-what">{sentence(card.summary)}</p>
      {(card.current !== null || card.proposed !== null) && (
        <dl className="ak-change-vals">
          <div>
            <dt>{card.status === "applied" ? tr("change.was") : tr("change.now")}</dt>
            <dd>{card.current ?? "—"}</dd>
          </div>
          {card.proposed !== null && (
            <div>
              <dt>{card.status === "applied" ? tr("change.now") : tr("change.new")}</dt>
              <dd>
                {card.status === "applied" ? (
                  <span className="marked">{card.proposed}</span>
                ) : (
                  card.proposed
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="ak-change-acts">
        {canConfirm(card) ? (
          <button type="button" className="act" disabled={busy} onClick={() => void confirm()}>
            {card.confirm}
          </button>
        ) : (
          <span />
        )}
        <Link className="act" href={card.link}>
          {tr("change.open")} <span aria-hidden="true">→</span>
        </Link>
      </div>
      {busy && (
        <p className="ak-change-live" role="status">
          <span className="live-dot" aria-hidden="true" /> {tr("change.making")}
        </p>
      )}
      {flag && card.result && (
        <p className="ak-change-result" role="status">
          <span className={`flag ${flag.tone}`}>{flag.word}</span> {card.result}
        </p>
      )}
      {error && (
        <p className="ak-change-result" role="alert">
          <span className="flag drift">{tr("change.notChanged")}</span> {error}
        </p>
      )}
    </section>
  );
}
