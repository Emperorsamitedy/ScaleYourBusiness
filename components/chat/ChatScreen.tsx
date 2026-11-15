"use client";

// Ask me anything — the conversation (step 46a + P3-36; the owner's chat
// design, 2026-10-17). The only owner-initiated surface in the product
// (conversation-channel §7): everything else the system starts. One paper
// sheet holds the thread, titled with the owner's latest question, and the
// composer; a side sheet lists the owner's earlier questions. A request
// only ever becomes a proposal in the queue — nothing runs on phrasing —
// and the link to it is the one thing that asks for a decision.
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
// SYB's answers as the model wrote them (L-5), and the server's own
// refusal sentences (L-4) are shown as they are.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { businessNoun } from "../../lib/core/business-noun";
import { Fold } from "../sheet/Fold";
import { useTr } from "../sheet/useTr";
import { MicButton } from "../voice/MicButton";
import { ChangeCard } from "./ChangeCard";
import type { ChangeCardView, Turn } from "./chat-view";
import {
  cardsFor,
  earlierQuestions,
  latestQuestion,
  paragraphs,
  stamp,
  upsertCard,
} from "./chat-view";
import "../../app/chat.css";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | {
      phase: "ready";
      turns: Turn[];
      cards: ChangeCardView[];
      draft: string;
      busy: boolean;
      lastProposal: string | null;
    };

/** The service's own ceiling on one message (lib/chat/service.ts). */
const MAX_CHARS = 4000;

export function ChatScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [business, setBusiness] = useState<string | null>(null);
  // "your salon", "your gym" — from the business_type answer; "your business" until known.
  const [englishNoun, setNoun] = useState(businessNoun(null));
  const { tr, locale } = useTr("chat");
  const tChat = useTranslations("chat");
  // English's noun table ("your salon"); other languages say "your business".
  const noun = locale === "en" ? englishNoun : tr("yourBusiness");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The composer's text as of the last change, kept in step on every write
  // so the microphone (idea 50) can tell the owner's typing from its own.
  const draftRef = useRef("");
  const turnCount = state.phase === "ready" ? state.turns.length : 0;
  const busy = state.phase === "ready" && state.busy;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat");
      if (res.status === 401) return setState({ phase: "signedout" });
      if (!res.ok) return setState({ phase: "error" });
      const j = (await res.json()) as { turns: Turn[]; changes?: ChangeCardView[] };
      setState({
        phase: "ready",
        turns: j.turns,
        cards: j.changes ?? [],
        draft: "",
        busy: false,
        lastProposal: null,
      });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
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
  }, [load]);

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
                  {tr("signedOut.begin")} <span aria-hidden="true">→</span>
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

  const send = async () => {
    const text = s.draft.trim();
    if (text === "" || s.busy) return;
    const optimistic: Turn = {
      id: `tmp-${Date.now()}`,
      role: "owner",
      text,
      at: new Date().toISOString(),
      intent: null,
    };
    draftRef.current = "";
    setState({ ...s, turns: [...s.turns, optimistic], draft: "", busy: true });
    let reply: Turn | null = null;
    let error: string | null = null;
    let proposal: string | null = null;
    let card: ChangeCardView | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        reply?: Turn;
        proposal_id?: string | null;
        change?: ChangeCardView | null;
        error?: string;
      };
      reply = j.reply ? { ...j.reply, intent: j.reply.intent ?? null } : null;
      error = j.error ?? null;
      proposal = j.proposal_id ?? null;
      card = j.change ?? null;
    } catch {
      // Unreachable server: the fallback line below says so.
    }
    setState((cur) => {
      if (cur.phase !== "ready") return cur;
      const turns = reply
        ? [...cur.turns, reply]
        : [
            ...cur.turns,
            {
              id: `err-${Date.now()}`,
              role: "system" as const,
              text: error ?? tr("sendFailed"),
              at: new Date().toISOString(),
              intent: null,
            },
          ];
      return {
        ...cur,
        turns,
        cards: card ? upsertCard(cur.cards, card) : cur.cards,
        busy: false,
        lastProposal: proposal,
      };
    });
  };

  const onChanged = (card: ChangeCardView) =>
    setState((cur) =>
      cur.phase === "ready" ? { ...cur, cards: upsertCard(cur.cards, card) } : cur,
    );

  const setDraft = (draft: string) => {
    draftRef.current = draft;
    setState((cur) => (cur.phase === "ready" ? { ...cur, draft } : cur));
  };

  const newQuestion = () => {
    setDraft("");
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
            {s.turns.map((t) => (
              <article key={t.id} id={`turn-${t.id}`} className={`ak-turn ${t.role}`}>
                <p className="ak-who">
                  {t.role === "owner" ? tr("you") : "ScaleX"}
                  {stamp(t.at, now, locale) !== "" && (
                    <span className="ak-at">{stamp(t.at, now, locale)}</span>
                  )}
                </p>
                <div className="ak-text">
                  {t.role === "owner" ? (
                    <p>{t.text}</p>
                  ) : (
                    paragraphs(t.text).map((p, i) => <p key={i}>{p}</p>)
                  )}
                  {t.role === "system" &&
                    cardsFor(t.id, s.cards).map((c) => (
                      <ChangeCard key={c.id} card={c} onChanged={onChanged} />
                    ))}
                </div>
              </article>
            ))}
            {s.busy && (
              <article className="ak-turn system" aria-busy="true">
                <p className="ak-who live">
                  <span className="live-dot" aria-hidden="true" /> ScaleX
                </p>
                <div className="ak-text">
                  <p className="ak-thinking">{tr("thinking")}</p>
                </div>
              </article>
            )}
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

          <form
            className="ak-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="ak-label" htmlFor="ak-input">
              {tr("composer.label", { noun })}
            </label>
            <div className="ak-row">
              <textarea
                id="ak-input"
                ref={inputRef}
                className="ak-input"
                rows={2}
                maxLength={MAX_CHARS}
                placeholder={tr("composer.placeholder")}
                value={s.draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={s.busy}
                aria-describedby="ak-rule"
              />
              <button
                type="submit"
                className="next ak-ask"
                disabled={s.busy || s.draft.trim() === ""}
              >
                {tr("composer.ask")} <span aria-hidden="true">→</span>
              </button>
            </div>
            <MicButton
              label={tr("composer.speak")}
              getText={() => draftRef.current}
              setText={(next) => setDraft(next.slice(0, MAX_CHARS))}
              after={tr("composer.spokenAfter")}
              disabled={s.busy}
            />
            <Fold className="ak-rule">
              {s.turns.length === 0 && (
                <p>{tChat.rich("empty", { noun, em: (chunks) => <em>{chunks}</em> })}</p>
              )}
              <p id="ak-rule">{tr("composer.rule")}</p>
            </Fold>
          </form>
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
