"use client";

// Ask Lex — the conversation (step 46a + P3-36; the owner's chat design,
// 2026-10-17; the assistant named 2026-11-17). The only owner-initiated
// surface in the product (conversation-channel §7): everything else the
// system starts. One paper sheet holds the thread, titled with the owner's
// latest question, and the composer; a side sheet lists the owner's
// earlier questions. A request only ever becomes a proposal — nothing runs
// on phrasing — and that proposal is answered right under the reply
// (InPlaceDecision.tsx): two equal answers, a reason on decline, recorded
// with the signed-in name like any other.
//
// The conversation is the frame's one (useChat.ts): what is asked here
// shows on Home and in Lex's sheet, and the other way round.
//
// Feature 33: when the owner asks for a CHANGE, the reply carries a change
// card (ChangeCard.tsx) — the drafted change, what is set now, "Make this
// change" and "Open the page". The card is the only place a click writes.
//
// The design's "sources for this answer" side sheet is not drawn: the
// chat service returns no citations, and a source list made up on this
// side would be exactly the unexplainable number rule 6 forbids.
//
// Small text (the owner, 2026-11-17): the opening paragraph and the
// composer's rule left the screen. One line says what Lex answers from,
// and while the thread is empty three chips ask a first question.
//
// L-3c (TASKS-LANGUAGES.md): the screen's fixed words are the "chat"
// catalogue and the stamps follow the reader's locale; the microphone
// listens in it. The turns are content: the owner's questions as typed,
// Lex's answers as the model wrote them (L-5), and the server's own
// refusal sentences (L-4) are shown as they are.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMessages } from "next-intl";
import { businessNoun } from "../../lib/core/business-noun";
import { knowsNothing } from "../home/next-steps";
import { useTr } from "../sheet/useTr";
import { ChatBusy, ChatTurn } from "./ChatTurn";
import { Composer } from "./Composer";
import { InPlaceDecision } from "./InPlaceDecision";
import { InterviewOffer } from "./InterviewOffer";
import { LexInterview } from "./LexInterview";
import { TryAgain } from "./TryAgain";
import { earlierQuestions, latestQuestion } from "./chat-view";
import { useChat } from "./useChat";
import "../../app/chat.css";

/** The questions a chip asks, in the order shown; Home's own (home.ask.chip). */
const CHIPS = ["today", "sales", "first"] as const;

/** The chips' words where the catalogue has them; none where it does not. */
export function chipQuestions(messages: unknown): string[] {
  const chip = (messages as { home?: { ask?: { chip?: Record<string, unknown> } } })?.home?.ask
    ?.chip;
  if (!chip) return [];
  return CHIPS.map((k) => chip[k]).filter((q): q is string => typeof q === "string" && q !== "");
}

export function ChatScreen() {
  const chat = useChat();
  const { state } = chat;
  const [business, setBusiness] = useState<string | null>(null);
  // "your salon", "your gym" — from the business_type answer; "your business" until known.
  const [englishNoun, setNoun] = useState(businessNoun(null));
  // How many facts the business has told; null until the menu's read answers.
  const [facts, setFacts] = useState<number | null>(null);
  // The interview with Lex (M4), started here or by an address that asks for it.
  const [interviewing, setInterviewing] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("interview") === "1",
  );
  const { tr, locale } = useTr("chat");
  const chips = chipQuestions(useMessages());
  // English's noun table ("your salon"); other languages say "your business".
  const noun = locale === "en" ? englishNoun : tr("yourBusiness");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const turnCount = state.phase === "ready" ? state.turns.length : 0;
  const busy = state.phase === "ready" && state.busy;

  useEffect(() => {
    // The business's name and type, as the menu reads them; absent stays absent.
    void fetch("/api/nav")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              business: string | null;
              business_type?: string | null;
              facts?: number;
            }>)
          : null,
      )
      .then((j) => {
        setBusiness(j?.business ?? null);
        setNoun(businessNoun(j?.business_type));
        setFacts(typeof j?.facts === "number" ? j.facts : null);
      })
      .catch(() => setBusiness(null));
  }, []);

  // Follow the thread as it grows, not on every keystroke.
  useEffect(() => {
    if (turnCount > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnCount, busy]);

  const kicker = tr("kicker", { about: business ?? noun });

  if (state.phase === "loading") {
    return (
      <main className="screen ak-screen">
        <p className="ak-wait">{tr("loading")}</p>
      </main>
    );
  }
  if (state.phase === "signedout" || state.phase === "error") {
    return (
      <main className="screen ak-screen">
        <div className="ak-layout">
          <section className="cs ak-sheet">
            <header className="cs-head">
              <div>
                <p className="cs-label">{kicker}</p>
                <h1 className="cs-title ak-title">
                  {state.phase === "signedout" ? tr("signedOut.title") : tr("error.title")}
                </h1>
              </div>
            </header>
            <div className="cs-body">
              <p className="ak-copy">
                {state.phase === "signedout" ? tr("signedOut.copy") : tr("error.copy")}
              </p>
              {state.phase === "signedout" && (
                <Link className="next" href="/intake">
                  {tr("signedOut.begin")}
                </Link>
              )}
            </div>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
  const now = Date.now();
  const question = latestQuestion(s.turns);
  const earlier = earlierQuestions(s.turns);

  const newQuestion = () => {
    chat.setDraft("");
    inputRef.current?.focus();
  };

  return (
    <main className="screen ak-screen">
      <div className={`ak-layout${earlier.length > 0 ? " with-side" : ""}`}>
        <section className="cs ak-sheet" aria-labelledby="ak-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">{kicker}</p>
              <h1 className="cs-title ak-title" id="ak-title">
                {question ?? tr("titleEmpty")}
              </h1>
            </div>
            {question !== null && (
              <button type="button" className="ak-new" onClick={newQuestion}>
                {tr("newQuestion")}
              </button>
            )}
          </header>

          <div className="ak-thread" aria-live="polite">
            {/* L8: with nothing to answer from, Lex offers the interview instead of questions. */}
            {s.turns.length === 0 && knowsNothing(facts) && !interviewing && (
              <InterviewOffer onWithLex={() => setInterviewing(true)} />
            )}
            {interviewing && <LexInterview onStop={() => setInterviewing(false)} />}
            {s.turns.length === 0 && !knowsNothing(facts) && (
              <div className="ak-start">
                <p className="ak-descriptor">{tr("descriptor")}</p>
                {chips.length > 0 && (
                  <div className="ak-chips">
                    {chips.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className="ak-chip"
                        disabled={s.busy}
                        onClick={() => void chat.ask(q, tr("sendFailed"))}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {s.turns.map((turn, i) => (
              <ChatTurn
                key={turn.id}
                turn={turn}
                cards={s.cards}
                onChanged={chat.onChanged}
                now={now}
                locale={locale}
                tr={tr}
              >
                {i === s.turns.length - 1 && turn.role === "system" && s.lastProposal && (
                  <InPlaceDecision id={s.lastProposal} />
                )}
                <TryAgain chat={chat} turn={turn} last={i === s.turns.length - 1} tr={tr} />
              </ChatTurn>
            ))}
            {s.busy && <ChatBusy text={tr("thinking")} />}
            <div ref={endRef} />
          </div>

          <Composer
            label={tr("composer.label", { noun })}
            draft={s.draft}
            busy={s.busy}
            setDraft={chat.setDraft}
            draftRef={chat.draftRef}
            onSend={() => void chat.send(tr("sendFailed"))}
            tr={tr}
            inputRef={inputRef}
            compact
          />
        </section>

        {earlier.length > 0 && (
          <aside className="cs ak-side" aria-labelledby="ak-earlier">
            <div className="ak-side-body">
              <h2 className="cs-label" id="ak-earlier">
                {tr("earlier")}
              </h2>
              <ul className="ak-earlier">
                {earlier.map((q) => (
                  <li key={q.id}>
                    <a href={`#turn-${q.id}`}>{q.text}</a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
