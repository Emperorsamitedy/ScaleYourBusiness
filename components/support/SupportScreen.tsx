"use client";

// The owner's support screen — Phase 4 Session B. Four things, plainly:
// the widget's public key and the one-line snippet that embeds it; the
// knowledge base (what the assistant may say — proposed from facts,
// approved in the queue, published here, retired here); the tickets
// where a human was asked for; and the conversations as they happened.
// Nothing on this screen touches a customer's account or executes
// anything — the assistant answers, and that is all it does.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Settings {
  site_key: string;
  business_name: string;
  rotated_at: string | null;
  snippet: string;
}

interface Entry {
  id: string;
  question: string;
  answer: string;
  source_keys: string[];
  status: "public" | "retired";
  published_at: string;
}

interface Publishable {
  id: string;
  summary: string;
}

interface Ticket {
  id: string;
  conversation_id: string | null;
  reason: "customer_asked" | "no_answer" | "cost_cap" | "conversation_cap";
  summary: string;
  status: "open" | "answered" | "closed";
  created_at: string;
}

interface Conversation {
  id: string;
  status: "open" | "escalated" | "closed";
  turns: number;
  cost_eur: string;
  started_at: string;
  last_at: string;
}

interface Message {
  id: string;
  role: "customer" | "assistant";
  text: string;
  at: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | {
      phase: "ready";
      settings: Settings | null;
      knowledge: Entry[];
      publishable: Publishable[];
      tickets: Ticket[];
      conversations: Conversation[];
      busy: boolean;
      notice: string | null;
      open: string | null;
      transcript: Message[];
      question: string;
      answer: string;
    };

const REASON_WORD: Record<Ticket["reason"], string> = {
  customer_asked: "asked for a person",
  no_answer: "no approved answer",
  cost_cap: "spend cap reached",
  conversation_cap: "conversation ran long",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SupportScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/support");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json()) as {
      settings: Settings | null;
      knowledge: Entry[];
      publishable: Publishable[];
      tickets: Ticket[];
      conversations: Conversation[];
    };
    setState({
      phase: "ready",
      ...j,
      busy: false,
      notice: null,
      open: null,
      transcript: [],
      question: "",
      answer: "",
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Opening support…</p>
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">support</span>
            <h1 className="auth-title">Start with the intake.</h1>
            <p className="auth-copy">
              The customer assistant answers from facts you give in the intake and approve for the
              public. Twelve questions and there is something real to publish.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              Begin
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
  const act = async (payload: Record<string, unknown>, doneNotice: string) => {
    setState({ ...s, busy: true, notice: null });
    const res = await fetch("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) {
      setState({ ...s, busy: false, notice: j.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) => (cur.phase === "ready" ? { ...cur, notice: doneNotice } : cur));
  };

  const openTranscript = async (id: string) => {
    if (s.open === id) return setState({ ...s, open: null, transcript: [] });
    const res = await fetch(`/api/support?conversation=${id}`);
    const j = (await res.json()) as { messages: Message[] };
    setState({ ...s, open: id, transcript: j.messages });
  };

  const openTickets = s.tickets.filter((t) => t.status === "open");
  const publicEntries = s.knowledge.filter((e) => e.status === "public");

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          support · {publicEntries.length} approved answers · {openTickets.length} waiting for you
        </span>
      </header>

      {s.notice && (
        <section className="card ops-card">
          <p className="auth-copy" aria-live="polite">
            {s.notice}
          </p>
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">the widget — an assistant that says it is one</span>
        {s.settings ? (
          <>
            <p className="auth-copy">
              Paste this one line into your website. Visitors see an assistant that introduces
              itself as automated, answers only from the approved list below, and hands over to you
              the moment they ask for a person.
            </p>
            <pre className="ct-body">{s.settings.snippet}</pre>
            <div className="prop-actions">
              <Link className="prop-btn" href="/support/test">
                Try it on a test page
              </Link>
              <button
                className="prop-btn quiet"
                disabled={s.busy}
                onClick={() =>
                  void act(
                    { action: "rotate" },
                    "New key. Every page with the old snippet stops working until you update it.",
                  )
                }
              >
                Rotate the key
              </button>
            </div>
            <p className="conn-note">
              The key is public by design — it only says which business a conversation belongs to.
              It is not a login, and the widget never touches your sign-in.
            </p>
          </>
        ) : (
          <>
            <p className="auth-copy">
              Not enabled yet. Enabling creates the widget&apos;s public key; nothing is said to
              anyone until you approve answers below.
            </p>
            <button
              className="prop-btn signal"
              disabled={s.busy}
              onClick={() => void act({ action: "enable" }, "Enabled. Now approve some answers.")}
            >
              Enable the assistant
            </button>
          </>
        )}
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">what it may say — approved by you, nothing else</span>
        <p className="auth-copy">
          Answers are rendered from facts you gave in the intake, put in your{" "}
          <Link href="/proposals">approval queue</Link>, and published here once you approve.
          Retiring one takes it out of the assistant&apos;s mouth immediately.
        </p>
        <div className="prop-actions">
          <button
            className="prop-btn"
            disabled={s.busy}
            onClick={() =>
              void act(
                { action: "propose_knowledge" },
                "Proposed. Approve it in the queue, then publish it here.",
              )
            }
          >
            Propose answers from my facts
          </button>
        </div>
        <form
          className="ct-goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              { action: "propose_custom", question: s.question, answer: s.answer },
              "Proposed. Approve it in the queue, then publish it here.",
            );
          }}
        >
          <input
            className="ct-input"
            placeholder="A question customers ask"
            value={s.question}
            onChange={(e) => setState({ ...s, question: e.target.value })}
          />
          <input
            className="ct-input"
            placeholder="The answer, in your words"
            value={s.answer}
            onChange={(e) => setState({ ...s, answer: e.target.value })}
          />
          <button
            className="prop-btn"
            disabled={s.busy || s.question.trim() === "" || s.answer.trim() === ""}
          >
            Propose this answer
          </button>
        </form>
        {s.publishable.length > 0 && (
          <div className="ct-suggestions">
            {s.publishable.map((p) => (
              <div key={p.id} className="ct-producible">
                <span>{p.summary} — approved, not yet public</span>
                <button
                  className="prop-btn signal"
                  disabled={s.busy}
                  onClick={() =>
                    void act(
                      { action: "publish", proposal_id: p.id },
                      "Published. The assistant can say these now.",
                    )
                  }
                >
                  Publish
                </button>
              </div>
            ))}
          </div>
        )}
        {s.knowledge.length === 0 && <p className="conn-note">No answers yet.</p>}
        {s.knowledge.map((e) => (
          <article key={e.id} className="ct-item">
            <div className="ct-item-head">
              <span
                className={`prop-tag ct-status ct-status-${e.status === "public" ? "published" : "withdrawn"}`}
              >
                {e.status}
              </span>
              <span className="ct-item-title">{e.question}</span>
              {e.status === "public" && (
                <button
                  className="prop-btn quiet"
                  disabled={s.busy}
                  onClick={() =>
                    void act(
                      { action: "retire", entry_id: e.id },
                      "Retired. It will not be said again.",
                    )
                  }
                >
                  Retire
                </button>
              )}
            </div>
            <p className="auth-copy">{e.answer}</p>
            <p className="ct-disclosure">from {e.source_keys.join(", ")}</p>
          </article>
        ))}
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">waiting for a person — {openTickets.length}</span>
        {openTickets.length === 0 && (
          <p className="conn-note">Nobody is waiting. Every escalation lands here, with why.</p>
        )}
        {openTickets.map((t) => (
          <article key={t.id} className="ct-item">
            <div className="ct-item-head">
              <span className="prop-tag">{REASON_WORD[t.reason]}</span>
              <span className="ct-item-title">{when(t.created_at)}</span>
            </div>
            <pre className="ct-body">{t.summary}</pre>
            <div className="prop-actions">
              {t.conversation_id && (
                <button
                  className="prop-btn quiet"
                  onClick={() => void openTranscript(t.conversation_id!)}
                >
                  Read the conversation
                </button>
              )}
              <button
                className="prop-btn"
                disabled={s.busy}
                onClick={() =>
                  void act(
                    { action: "resolve_ticket", ticket_id: t.id, status: "answered" },
                    "Marked answered.",
                  )
                }
              >
                I answered them
              </button>
              <button
                className="prop-btn quiet"
                disabled={s.busy}
                onClick={() =>
                  void act(
                    { action: "resolve_ticket", ticket_id: t.id, status: "closed" },
                    "Closed.",
                  )
                }
              >
                Close
              </button>
            </div>
            {s.open === t.conversation_id && (
              <div className="ch-thread">
                {s.transcript.map((m) => (
                  <p key={m.id} className={`ch-turn ${m.role}`}>
                    <b>{m.role === "customer" ? "Customer" : "Assistant"}:</b> {m.text}
                  </p>
                ))}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">conversations — {s.conversations.length}</span>
        {s.conversations.length === 0 && <p className="conn-note">None yet.</p>}
        {s.conversations.map((c) => (
          <article key={c.id} className="ct-item">
            <div className="ct-item-head">
              <span className="prop-tag">{c.status}</span>
              <span className="ct-item-title">
                {when(c.last_at)} · {c.turns} message{c.turns === 1 ? "" : "s"} · €
                {Number.parseFloat(c.cost_eur).toFixed(4)}
              </span>
              <button className="prop-btn quiet" onClick={() => void openTranscript(c.id)}>
                {s.open === c.id ? "Close" : "Read"}
              </button>
            </div>
            {s.open === c.id && (
              <div className="ch-thread">
                {s.transcript.map((m) => (
                  <p key={m.id} className={`ch-turn ${m.role}`}>
                    <b>{m.role === "customer" ? "Customer" : "Assistant"}:</b> {m.text}
                  </p>
                ))}
              </div>
            )}
          </article>
        ))}
      </section>

      <p className="conn-note">
        The assistant reads approved answers and nothing else: not your profile, not your numbers,
        not your connections, and it cannot execute anything. A test proves that import by import.{" "}
        <Link href="/proposals">Proposals</Link> · <Link href="/chat">Your chat</Link>
      </p>
    </main>
  );
}
