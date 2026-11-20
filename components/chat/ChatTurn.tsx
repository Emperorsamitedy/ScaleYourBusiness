"use client";

// One turn of the conversation, as the chat screen and Home draw it: the
// owner's words, or Lex's reply with the change cards it carries. Lex
// speaks under its own face (components/brand/LexFace.tsx), so the reader always
// sees who wrote what: the owner's own assistant is named the way a
// customer-facing one says it is one (rule 20).

import type { ReactNode } from "react";
import Link from "next/link";
import { linksIn } from "../../lib/assistant/guide";
import type { GuideScreen } from "../../lib/assistant/guide";
import { ASSISTANT } from "../../lib/core/assistant";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { LexFace } from "../brand/LexFace";
import { useTr } from "../sheet/useTr";
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
  onInterview,
  children,
}: {
  turn: Turn;
  cards: readonly ChangeCardView[];
  onChanged: (card: ChangeCardView) => void;
  now: number;
  locale: AppLocale;
  /** The "chat" catalogue. */
  tr: Tr;
  /**
   * Starts the interview in the conversation. Given, a reply that names the
   * interview offers "Do it with Lex" beside the way to the form: asked for
   * the interview in any words and any language, Lex's answer is one press
   * from it.
   */
  onInterview?: () => void;
  /** Anything the caller lays under the reply, such as the proposal it became. */
  children?: ReactNode;
}) {
  const at = stamp(turn.at, now, locale);
  const { tr: navTr } = useTr("nav");
  const { tr: homeTr } = useTr("home");
  // A screen's name as the menu says it; the two the menu does not list say what opening them does.
  const nameOf = (s: GuideScreen): string =>
    s.nav !== null
      ? navTr(`item.${s.nav}`)
      : s.route === "/intake"
        ? homeTr("fresh.start")
        : tr("openFull");
  // The screens a reply names become buttons to them (the owner's fourth
  // round: Lex guides). Only the guide's own screens: nothing a model writes
  // is ever made into a link.
  const screens = turn.role === "system" ? linksIn(turn.text) : [];
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
        {screens.length > 0 && (
          <p className="ak-links">
            {onInterview && screens.some((s) => s.route === "/intake") && (
              <button type="button" className="act solid" onClick={onInterview}>
                {tr("interview.withLex")}
              </button>
            )}
            {screens.map((s) => (
              <Link key={s.route} className="act" href={s.route}>
                {nameOf(s)}
              </Link>
            ))}
          </p>
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
