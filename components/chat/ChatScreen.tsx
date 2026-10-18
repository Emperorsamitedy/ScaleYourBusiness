"use client";

// Ask me anything — the conversation (step 46a + P3-36; the owner's chat
// design, 2026-10-17). The only owner-initiated surface in the product
// (conversation-channel §7): everything else the system starts. One paper
// sheet holds the thread, titled with the owner's latest question, and the
// composer; a side sheet lists the owner's earlier questions. A request
// only ever becomes a proposal in the queue — nothing runs on phrasing —
// and the link to it is the one thing that asks for a decision.
//
// The design's "sources for this answer" side sheet is not drawn: the
// chat service returns no citations, and a source list made up on this
// side would be exactly the unexplainable number rule 6 forbids.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Turn } from "./chat-view";
import { earlierQuestions, latestQuestion, paragraphs, stamp } from "./chat-view";
import "../../app/chat.css";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; turns: Turn[]; draft: string; busy: boolean; lastProposal: string | null };

/** The service's own ceiling on one message (lib/chat/service.ts). */
const MAX_CHARS = 4000;

export function ChatScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [business, setBusiness] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const turnCount = state.phase === "ready" ? state.turns.length : 0;
  const busy = state.phase === "ready" && state.busy;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat");
      if (res.status === 401) return setState({ phase: "signedout" });
      if (!res.ok) return setState({ phase: "error" });
      const j = (await res.json()) as { turns: Turn[] };
      setState({ phase: "ready", turns: j.turns, draft: "", busy: false, lastProposal: null });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
    // The business's name, as the menu reads it; absent stays absent.
    void fetch("/api/nav")
      .then((r) => (r.ok ? (r.json() as Promise<{ business: string | null }>) : null))
      .then((j) => setBusiness(j?.business ?? null))
      .catch(() => setBusiness(null));
  }, [load]);

  // Follow the thread as it grows, not on every keystroke.
  useEffect(() => {
    if (turnCount > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnCount, busy]);

  const kicker = `Ask me anything · About ${business ?? "your business"}`;

  if (state.phase === "loading") {
    return (
      <main className="screen ak-screen">
        <p className="ak-wait">Opening the conversation…</p>
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
                  {state.phase === "signedout"
                    ? "I answer from your business."
                    : "The conversation didn't load."}
                </h1>
              </div>
            </header>
            <div className="cs-body">
              <p className="ak-copy">
                {state.phase === "signedout"
                  ? "This channel is grounded in one profile — yours. Start the intake and there is something real to talk about."
                  : "Something went wrong reading the thread. Refresh to try again."}
              </p>
              {state.phase === "signedout" && (
                <Link className="next" href="/intake">
                  Begin <span aria-hidden="true">→</span>
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
    setState({ ...s, turns: [...s.turns, optimistic], draft: "", busy: true });
    let reply: Turn | null = null;
    let error: string | null = null;
    let proposal: string | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        reply?: Turn;
        proposal_id?: string | null;
        error?: string;
      };
      reply = j.reply ? { ...j.reply, intent: j.reply.intent ?? null } : null;
      error = j.error ?? null;
      proposal = j.proposal_id ?? null;
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
              text: error ?? "Something went wrong on my side — say that again?",
              at: new Date().toISOString(),
              intent: null,
            },
          ];
      return { ...cur, turns, busy: false, lastProposal: proposal };
    });
  };

  const newQuestion = () => {
    setState({ ...s, draft: "" });
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
                {question ?? "What would you like to know?"}
              </h1>
            </div>
            {question !== null && (
              <button type="button" className="ak-new" onClick={newQuestion}>
                New question
              </button>
            )}
          </header>

          <div className="ak-thread" aria-live="polite">
            {s.turns.length === 0 && (
              <p className="ak-copy ak-empty">
                Ask me anything about your business — why the report said what it said, what your
                numbers show, what I&rsquo;d watch. If you ask me to <em>do</em> something, it
                becomes a proposal in your queue; nothing runs on phrasing alone.
              </p>
            )}
            {s.turns.map((t) => (
              <article key={t.id} id={`turn-${t.id}`} className={`ak-turn ${t.role}`}>
                <p className="ak-who">
                  {t.role === "owner" ? "You" : "Ledgerline"}
                  {stamp(t.at, now) !== "" && <span className="ak-at">{stamp(t.at, now)}</span>}
                </p>
                <div className="ak-text">
                  {t.role === "owner" ? (
                    <p>{t.text}</p>
                  ) : (
                    paragraphs(t.text).map((p, i) => <p key={i}>{p}</p>)
                  )}
                </div>
              </article>
            ))}
            {s.busy && (
              <article className="ak-turn system" aria-busy="true">
                <p className="ak-who live">
                  <span className="live-dot" aria-hidden="true" /> Ledgerline
                </p>
                <div className="ak-text">
                  <p className="ak-thinking">Reading your profile…</p>
                </div>
              </article>
            )}
            {s.lastProposal && (
              <div className="ak-turn system">
                <span aria-hidden="true" />
                <p className="ak-queued inset">
                  It&rsquo;s a proposal now, waiting for your yes.{" "}
                  <Link href="/proposals">Open Waiting for you →</Link>
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
              Ask about your business
            </label>
            <div className="ak-row">
              <textarea
                id="ak-input"
                ref={inputRef}
                className="ak-input"
                rows={2}
                maxLength={MAX_CHARS}
                placeholder="Type a question…"
                value={s.draft}
                onChange={(e) => setState({ ...s, draft: e.target.value })}
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
                Ask <span aria-hidden="true">→</span>
              </button>
            </div>
            <p className="ak-rule" id="ak-rule">
              I answer only from what your profile and report hold. Anything I suggest becomes a
              proposal you approve; limits you state here stick.
            </p>
          </form>
        </section>

        {earlier.length > 0 && (
          <aside className="cs ak-side" aria-labelledby="ak-earlier">
            <div className="ak-side-body">
              <h2 className="cs-label" id="ak-earlier">
                Earlier questions
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
