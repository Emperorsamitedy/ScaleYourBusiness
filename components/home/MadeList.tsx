"use client";

// Home's "Made" list (docs/DASHBOARD-OVERHAUL.md C7): everything Lex
// drafted, whatever became of it, each with one line of the thing itself
// and its state as a word. A row opens the decision in place: with its
// answers while it waits, read-only once answered. made-model.ts decides
// the rows and the line; this file draws them.

import { useTranslations } from "next-intl";
import { changeLines } from "../proposals/queue-model";
import { useTr } from "../sheet/useTr";
import type { MadeProposal, MadeRow, MadeState } from "./made-model";
import { previewOf } from "./made-model";

/** The tint behind each state's word; the word carries the meaning. */
const TONE: Readonly<Record<MadeState, "" | "ok" | "low" | "drift">> = {
  // Waiting is the owner's turn, in plain ink: cobalt is only ever the machine working.
  waiting: "",
  approved: "ok",
  done: "ok",
  declined: "low",
  changes: "low",
  expired: "drift",
  blocked: "drift",
};

export function MadeList<P extends MadeProposal>({
  rows,
  onReview,
}: {
  rows: readonly MadeRow<P>[];
  onReview: (id: string) => void;
}) {
  const t = useTranslations("home");
  const qw = useTr("queueWords");
  if (rows.length === 0) return <p className="home-empty">{t("made.empty")}</p>;
  return (
    <ul className="hm">
      {rows.map(({ proposal: p, state }) => {
        const preview = previewOf(p.action.detail, changeLines(p.action, undefined, qw));
        return (
          <li key={p.id}>
            <button type="button" className="hm-row" onClick={() => onReview(p.id)}>
              <span className="hm-title">{p.action.summary}</span>
              {preview && <span className="hm-prev">{preview}</span>}
              <span className={`flag ${TONE[state]}`.trim()}>
                {state === "waiting" ? t("made.waiting") : t(`feed.tag.${state}`)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
