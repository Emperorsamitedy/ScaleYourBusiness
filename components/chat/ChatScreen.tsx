"use client";

// Ask Lex — the conversation (step 46a + P3-36; the owner's chat design,
// 2026-10-17; the assistant named 2026-11-17). The only owner-initiated
// surface in the product (conversation-channel §7): everything else the
// system starts. One paper sheet holds the thread, titled with the owner's
// latest question, and the composer; a side sheet lists the owner's
// earlier questions. A request only ever becomes a proposal in the queue —
// nothing runs on phrasing — and the proposal's own card is the one thing
// that asks for a decision. Home (components/home/HomeScreen.tsx) carries
// the same conversation through the same hook (useChat.ts) and pieces
// (ChatTurn.tsx, Composer.tsx).
//
// Feature 33: when the owner asks for a CHANGE, the reply carries a change
// card (ChangeCard.tsx) — the drafted change, what is set now, "Make this
// change" and "Open the page". The card is the only place a click writes.
//
// The design's "sources for this answer" side sheet is not drawn: the
// chat service returns no citations, and a source list made up on this
// side would be exactly the unexplainable number rule 6 forbids.
//
// L-3c (TASKS-LANGUAGES.md): the screen's fixed words are the "chat"
// catalogue and the stamps follow the reader's locale; the microphone
// listens in it. The turns are content: the owner's questions as typed,
// Lex's answers as the model wrote them (L-5), and the server's own
// refusal sentences (L-4) are shown as they are.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { businessNoun } from "../../lib/core/business-noun";
import { useTr } from "../sheet/useTr";
import { ChatBusy, ChatTurn } from "./ChatTurn";
import { Composer } from "./Composer";
import { earlierQuestions, latestQuestion } from "./chat-view";
import { useChat } from "./useChat";
import "../../app/chat.css";

export function ChatScreen() {
  const chat = useChat();
  const { state } = chat;
  const [business, setBusiness] = useState<string | null>(null);
  // "your salon", "your gym" — from the business_type answer; "your business" until known.
  const [englishNoun, setNoun] = useState(businessNoun(null));
  const { tr, locale } = useTr("chat");
  const tChat = useTranslations("chat");
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
          ? (r.json() as Promise<{ business: string | null; business_type?: string | null }>)
          : null,
      )
      .then((j) => {
        setBusiness(j?.business ?? null);
        setNoun(businessNoun(j?.business_type));
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
            {s.turns.map((turn) => (
              <ChatTurn
                key={turn.id}
                turn={turn}
                cards={s.cards}
                onChanged={chat.onChanged}
                now={now}
                locale={locale}
                tr={tr}
              />
            ))}
            {s.busy && <ChatBusy text={tr("thinking")} />}
            {s.lastProposal && (
              <div className="ak-turn system">
                <span aria-hidden="true" />
                <p className="ak-queued inset">
                  {tr("queued.text")} <Link href="/proposals">{tr("queued.link")}</Link>
                </p>
              </div>
            )}
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
            intro={
              s.turns.length === 0 ? (
                <p>{tChat.rich("empty", { noun, em: (chunks) => <em>{chunks}</em> })}</p>
              ) : undefined
            }
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
