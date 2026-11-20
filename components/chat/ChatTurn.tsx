"use client";

// One turn of the conversation, as the chat screen and Home draw it: the
// owner's words, or Lex's reply with the change cards it carries. Lex
// speaks under its own face (components/brand/LexFace.tsx), so the reader always
// sees who wrote what: the owner's own assistant is named the way a
// customer-facing one says it is one (rule 20).

import type { ReactNode } from "react";
import { ASSISTANT } from "../../lib/core/assistant";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { LexFace } from "../brand/LexFace";
import { ChangeCard } from "./ChangeCard";
import type { ChangeCardView, Turn } from "./chat-view";
import { cardsFor, paragraphs, stamp } from "./chat-view";

/** Lex's name with its face before it; the face works while an answer is on its way. */
export function Speaker({ live = false }: { live?: boolean }) {
  return (
    <span className={`ak-lex${live ? " live" : ""}`}>
      <LexFace size={20} state={live ? "working" : "idle"} />
      {ASSISTANT}
    </span>
  );
}

export function ChatTurn({
  turn,
  cards,
  onChanged,
  now,
  locale,
  tr,
  children,
}: {
  turn: Turn;
  cards: readonly ChangeCardView[];
  onChanged: (card: ChangeCardView) => void;
  now: number;
  locale: AppLocale;
  /** The "chat" catalogue. */
  tr: Tr;
  /** Anything the caller lays under the reply, such as the proposal it became. */
  children?: ReactNode;
}) {
  const at = stamp(turn.at, now, locale);
  return (
    <article id={`turn-${turn.id}`} className={`ak-turn ${turn.role}`}>
      <p className="ak-who">
        {turn.role === "owner" ? tr("you") : <Speaker />}
        {at !== "" && <span className="ak-at">{at}</span>}
      </p>
      <div className="ak-text">
        {turn.role === "owner" ? (
          <p>{turn.text}</p>
        ) : (
          paragraphs(turn.text).map((p, i) => <p key={i}>{p}</p>)
        )}
        {turn.role === "system" &&
          cardsFor(turn.id, cards).map((c) => (
            <ChangeCard key={c.id} card={c} onChanged={onChanged} />
          ))}
        {children}
      </div>
    </article>
  );
}

/** Lex while an answer is genuinely being written: cobalt, and only then. */
export function ChatBusy({ text }: { text: string }) {
  return (
    <article className="ak-turn system" aria-busy="true">
      <p className="ak-who live">
        <span className="live-dot" aria-hidden="true" /> <Speaker live />
      </p>
      <div className="ak-text">
        <p className="ak-thinking">{text}</p>
      </div>
    </article>
  );
}
