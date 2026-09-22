"use client";

// The conversation — step 46a + P3-36. The only owner-initiated
// surface in the product (conversation-channel §7): everything else
// the system starts. Chat is ink and grey; when a turn produces
// something needing a decision — a queued proposal — the LINK turns
// signal, not the conversation around it (the colour rule).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Turn {
  id: string;
  role: "owner" | "system";
  text: string;
  at: string;
  intent: string | null;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "ready"; turns: Turn[]; draft: string; busy: boolean; lastProposal: string | null };

export function ChatScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/chat");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json()) as { turns: Turn[] };
    setState({ phase: "ready", turns: j.turns, draft: "", busy: false, lastProposal: null });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Opening the conversation…</p>
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">conversation</span>
            <h1 className="auth-title">I answer from your business.</h1>
            <p className="auth-copy">
              This channel is grounded in one profile — yours. Start the intake and there is
              something real to talk about.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/intake">
              Begin
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
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
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const j = (await res.json()) as {
      reply?: Turn;
      proposal_id?: string | null;
      error?: string;
    };
    setState((cur) => {
      if (cur.phase !== "ready") return cur;
      const turns = j.reply
        ? [...cur.turns, j.reply]
        : [
            ...cur.turns,
            {
              id: `err-${Date.now()}`,
              role: "system" as const,
              text: j.error ?? "Something went wrong on my side — say that again?",
              at: new Date().toISOString(),
              intent: null,
            },
          ];
      return { ...cur, turns, busy: false, lastProposal: j.proposal_id ?? null };
    });
  };

  return (
    <main className="ops-shell ch-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">conversation · grounded in your profile</span>
      </header>

      <section className="card ops-card ch-thread">
        {s.turns.length === 0 && (
          <p className="auth-copy">
            Ask me anything about your business — why the report said what it said, what your
            numbers show, what I&rsquo;d watch. If you ask me to <em>do</em> something, it becomes a
            proposal in your queue; nothing runs on phrasing alone.
          </p>
        )}
        {s.turns.map((t) => (
          <div key={t.id} className={`ch-turn ${t.role}`}>
            <p className="ch-text">{t.text}</p>
          </div>
        ))}
        {s.busy && (
          <div className="ch-turn system">
            <p className="ch-text ch-thinking">…</p>
          </div>
        )}
        {s.lastProposal && (
          <p className="ch-queued">
            <Link href="/proposals">It&rsquo;s in your approval queue →</Link>
          </p>
        )}
        <div ref={endRef} />
      </section>

      <form
        className="ch-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="ct-input"
          placeholder="Ask about your business, or ask me to do something…"
          value={s.draft}
          onChange={(e) => setState({ ...s, draft: e.target.value })}
          disabled={s.busy}
        />
        <button className="prop-btn" disabled={s.busy || s.draft.trim() === ""}>
          Send
        </button>
      </form>

      <p className="conn-note">
        I answer only from what your profile and report hold — no generic advice at your expense.
        Requests become proposals; limits you state here stick.{" "}
        <Link href="/proposals">Proposals</Link> · <Link href="/report">Report</Link> ·{" "}
        <Link href="/history">The record</Link>
      </p>
    </main>
  );
}
