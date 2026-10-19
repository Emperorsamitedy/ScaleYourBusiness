"use client";

// The owner's support screen — Phase 4 Sessions B and D, in the owner's
// instrument design (2026-10-17). Left: what the assistant is allowed to
// say — approved answers, ones approved but not yet public, questions
// customers keep asking that nobody has answered, and the form that
// proposes a new one (approval happens in the queue). Right: the
// conversations, the open one's transcript, and — when it was handed to
// the owner — a place to record what they answered. Below: the widget's
// public key and snippet. Nothing on this screen touches a customer's
// account or executes anything (rule 21); what customers typed is shown
// as text and never acted on (rule 24); every assistant turn is labelled
// as automated (rule 20).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import "../../app/support.css";
import { PageHead } from "../sheet/PageHead";
import {
  type ConversationStatus,
  REASON_WORD,
  type TicketReason,
  type TicketStatus,
  conversationWord,
  supportHeadline,
  waitingTitle,
  whenShort,
} from "./support-view";

interface Settings {
  site_key: string;
  business_name: string;
  rotated_at: string | null;
  snippet: string;
  /** s-<token>@<domain>, or null when no inbound domain is configured. */
  inbound_address: string | null;
  inbound_rotated_at: string | null;
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
  contact_id: string | null;
  channel: "chat" | "email";
  reason: TicketReason;
  summary: string;
  status: TicketStatus;
  answer: string | null;
  created_at: string;
  /** The address is suppressed: the gate refuses every reply to it. */
  suppressed_address: boolean;
  /** The sender's name or address, for an email ticket. */
  from: string | null;
}

interface Email {
  id: string;
  direction: "inbound" | "outbound";
  from_address: string;
  from_name: string | null;
  subject: string;
  body: string;
  truncated: boolean;
  at: string;
}

interface Conversation {
  id: string;
  status: ConversationStatus;
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

interface FaqCluster {
  question: string;
  members: string[];
}

interface FaqOutcome {
  questions: number;
  clusters: FaqCluster[];
  proposal_id: string | null;
  unanswered: FaqCluster[];
}

/** One row of the conversation list: a widget conversation, or a ticket that has none. */
interface Thread {
  key: string;
  conversation: Conversation | null;
  ticket: Ticket | null;
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
      /** The selected thread's key. */
      open: string | null;
      transcript: Message[];
      /** Which conversation the transcript belongs to. */
      transcriptOf: string | null;
      /** The selected ticket's email thread, and which ticket it belongs to. */
      emails: Email[];
      emailsOf: string | null;
      writing: boolean;
      question: string;
      answer: string;
      ticketAnswers: Record<string, string>;
      faq: FaqOutcome | null;
      /** The conversation whose erasure awaits a second click. */
      confirmErase: string | null;
    };

function shortId(id: string): string {
  return `A-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function dayWord(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function threadsOf(conversations: Conversation[], tickets: Ticket[]): Thread[] {
  // The newest ticket per conversation speaks for it.
  const byConversation = new Map<string, Ticket>();
  for (const t of [...tickets].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (t.conversation_id) byConversation.set(t.conversation_id, t);
  }
  const threads: Thread[] = [
    ...conversations.map((c) => ({
      key: c.id,
      conversation: c,
      ticket: byConversation.get(c.id) ?? null,
      at: c.last_at,
    })),
    ...tickets
      .filter((t) => t.conversation_id === null)
      .map((t) => ({ key: `ticket:${t.id}`, conversation: null, ticket: t, at: t.created_at })),
  ];
  // Waiting first, then newest first.
  return threads.sort((a, b) => {
    const wa = a.ticket?.status === "open" ? 0 : 1;
    const wb = b.ticket?.status === "open" ? 0 : 1;
    return wa - wb || b.at.localeCompare(a.at);
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
    setState((cur) => ({
      phase: "ready",
      ...j,
      busy: false,
      notice: null,
      open: cur.phase === "ready" ? cur.open : null,
      transcript: cur.phase === "ready" ? cur.transcript : [],
      transcriptOf: cur.phase === "ready" ? cur.transcriptOf : null,
      emails: cur.phase === "ready" ? cur.emails : [],
      // Re-read after every load: a send or a new email changes the thread.
      emailsOf: null,
      writing: false,
      question: "",
      answer: "",
      ticketAnswers: cur.phase === "ready" ? cur.ticketAnswers : {},
      faq: cur.phase === "ready" ? cur.faq : null,
      confirmErase: null,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The selected thread's transcript, fetched when the selection lands on a conversation.
  const ready = state.phase === "ready" ? state : null;
  const threads = ready ? threadsOf(ready.conversations, ready.tickets) : [];
  const selected = threads.find((t) => t.key === ready?.open) ?? threads[0] ?? null;
  const wantTranscript = selected?.conversation?.id ?? null;
  const haveTranscript = ready?.transcriptOf ?? null;
  useEffect(() => {
    if (wantTranscript === null || wantTranscript === haveTranscript) return;
    let live = true;
    void (async () => {
      const res = await fetch(`/api/support?conversation=${encodeURIComponent(wantTranscript)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { messages: Message[] };
      if (!live) return;
      setState((cur) =>
        cur.phase === "ready"
          ? { ...cur, transcript: j.messages, transcriptOf: wantTranscript }
          : cur,
      );
    })();
    return () => {
      live = false;
    };
  }, [wantTranscript, haveTranscript]);

  // The selected ticket's email thread (P4-09), when it has an email side.
  const wantEmails = selected?.ticket ? selected.ticket.id : null;
  const haveEmails = ready?.emailsOf ?? null;
  useEffect(() => {
    if (wantEmails === null || wantEmails === haveEmails) return;
    let live = true;
    void (async () => {
      const res = await fetch(`/api/support?ticket=${encodeURIComponent(wantEmails)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { emails: Email[] };
      if (!live) return;
      setState((cur) =>
        cur.phase === "ready" ? { ...cur, emails: j.emails, emailsOf: wantEmails } : cur,
      );
    })();
    return () => {
      live = false;
    };
  }, [wantEmails, haveEmails]);

  if (state.phase === "loading") {
    return (
      <main className="screen sp-screen">
        <PageHead kicker="Customers · Support" title="Opening support…" />
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
  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as { error?: string } & Record<string, unknown>;
    return { ok: res.ok, json: j };
  };

  const act = async (payload: Record<string, unknown>, doneNotice: string) => {
    setState({ ...s, busy: true, notice: null });
    const { ok, json } = await post(payload);
    if (!ok) {
      setState({ ...s, busy: false, notice: json.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) => (cur.phase === "ready" ? { ...cur, notice: doneNotice } : cur));
  };

  const clusterFaq = async () => {
    setState({ ...s, busy: true, notice: null });
    const { ok, json } = await post({ action: "cluster_faq" });
    if (!ok) {
      setState({ ...s, busy: false, notice: json.error ?? "that didn't work" });
      return;
    }
    const outcome = json as unknown as FaqOutcome;
    await load();
    setState((cur) =>
      cur.phase === "ready"
        ? {
            ...cur,
            faq: outcome,
            notice:
              outcome.questions < 3
                ? `Only ${outcome.questions} open question${outcome.questions === 1 ? "" : "s"} — nothing to cluster yet. Three askers make a frequently asked question.`
                : outcome.proposal_id
                  ? "Clustered. The answers you already gave are in your approval queue; the rest are listed for you to answer."
                  : outcome.clusters.length === 0
                    ? "Clustered: no three people have asked the same thing yet."
                    : "Clustered. Nobody has answered these yet — answer one on its conversation and cluster again.",
          }
        : cur,
    );
  };

  const openTickets = s.tickets.filter((t) => t.status === "open");
  const publicEntries = s.knowledge.filter((e) => e.status === "public");
  const retired = s.knowledge.filter((e) => e.status !== "public");
  const unanswered = s.faq?.unanswered ?? [];
  const ticket = selected?.ticket ?? null;
  const conversation = selected?.conversation ?? null;
  const transcript = conversation && s.transcriptOf === conversation.id ? s.transcript : [];
  const emails = ticket && s.emailsOf === ticket.id ? s.emails : [];
  const typed = ticket ? (s.ticketAnswers[ticket.id] ?? "") : "";

  return (
    <main className="screen sp-screen">
      <PageHead kicker="Customers · Support" title={supportHeadline(publicEntries.length)}>
        <div className="sp-counts">
          <span>
            <b>{s.conversations.length}</b>{" "}
            {s.conversations.length === 1 ? "conversation" : "conversations"} ·{" "}
            <b>{s.tickets.length}</b> handed to you · <b>{openTickets.length}</b> waiting
          </span>
          <Link className="ghost sp-test" href="/support/test">
            Test the widget <span aria-hidden="true">→</span>
          </Link>
        </div>
      </PageHead>

      {s.notice && (
        <p className="sp-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      <div className="sp-grid">
        {/* ── what it may say ── */}
        <section className="cs sp-answers" aria-labelledby="sp-answers-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">Approved answers · {publicEntries.length}</p>
              <h2 className="cs-title" id="sp-answers-title">
                What it&rsquo;s allowed to say
              </h2>
            </div>
            <button
              type="button"
              className="prop-btn sp-small"
              aria-expanded={s.writing}
              aria-controls="sp-write"
              onClick={() => setState({ ...s, writing: !s.writing })}
            >
              {s.writing ? "Close" : "Write an answer"}
            </button>
          </header>
          <div className="cs-body">
            {s.writing && (
              <form
                id="sp-write"
                className="sp-box sp-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    { action: "propose_custom", question: s.question, answer: s.answer },
                    "Proposed. Approve it in the queue, then publish it here.",
                  );
                }}
              >
                <label className="cs-label" htmlFor="sp-q">
                  A question customers ask
                </label>
                <input
                  id="sp-q"
                  className="sp-input"
                  value={s.question}
                  onChange={(e) => setState({ ...s, question: e.target.value })}
                />
                <label className="cs-label" htmlFor="sp-a">
                  The answer, in your words
                </label>
                <textarea
                  id="sp-a"
                  className="sp-textarea"
                  rows={3}
                  value={s.answer}
                  onChange={(e) => setState({ ...s, answer: e.target.value })}
                />
                <div className="sp-row">
                  <button
                    className="prop-btn"
                    disabled={s.busy || s.question.trim() === "" || s.answer.trim() === ""}
                  >
                    Propose this answer
                  </button>
                  <span className="sp-fine">It goes to your approval queue first.</span>
                </div>
              </form>
            )}

            {s.publishable.map((p) => (
              <div key={p.id} className="sp-box">
                <p className="sp-box-label">
                  <span className="word ok">approved · not yet public</span>
                </p>
                <p className="sp-box-title">{p.summary}</p>
                <div className="sp-row">
                  <button
                    type="button"
                    className="prop-btn"
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
              </div>
            ))}

            {unanswered.map((c) => (
              <div key={c.question} className="sp-box">
                <p className="sp-box-label">
                  <span className="word drift">asked {c.members.length} times · not answered</span>
                </p>
                <p className="sp-box-title">{c.question}</p>
                <p className="sp-fine">
                  Answer it on one of its conversations, then cluster again.
                </p>
              </div>
            ))}

            {s.knowledge.length === 0 && !s.writing && (
              <p className="sp-empty">
                No answers yet. Until you approve some, the assistant says it doesn&rsquo;t know and
                hands the question to you.
              </p>
            )}

            {publicEntries.length > 0 && (
              <ul className="sp-entries">
                {publicEntries.map((e) => (
                  <EntryRow
                    key={e.id}
                    e={e}
                    busy={s.busy}
                    onRetire={() =>
                      void act(
                        { action: "retire", entry_id: e.id },
                        "Retired. It will not be said again.",
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {retired.length > 0 && (
              <>
                <p className="cs-label sp-gap">Retired · no longer said</p>
                <ul className="sp-entries sp-retired">
                  {retired.map((e) => (
                    <EntryRow key={e.id} e={e} busy={s.busy} />
                  ))}
                </ul>
              </>
            )}
          </div>
          <footer className="cs-foot sp-foot">
            <button
              type="button"
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
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy}
              onClick={() => void clusterFaq()}
            >
              Cluster what customers asked
            </button>
          </footer>
        </section>

        {/* ── conversations ── */}
        <section className="cs sp-convos" aria-labelledby="sp-convos-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">Conversations · {s.conversations.length}</p>
              <h2 className="cs-title" id="sp-convos-title">
                {waitingTitle(openTickets.length)}
              </h2>
            </div>
          </header>
          {threads.length === 0 ? (
            <div className="cs-body">
              <p className="sp-empty">
                No conversations yet. Every one the widget has lands here, and anything handed to
                you is marked.
              </p>
            </div>
          ) : (
            <div className="sp-split">
              <ul className="sp-list" aria-label="Conversations">
                {threads.map((t) => {
                  const w = conversationWord(t.conversation?.status ?? "escalated", t.ticket);
                  const on = selected?.key === t.key;
                  return (
                    <li key={t.key}>
                      <button
                        type="button"
                        className={`sp-thread${on ? " on" : ""}`}
                        aria-pressed={on}
                        onClick={() => setState({ ...s, open: t.key, confirmErase: null })}
                      >
                        <span className="sp-thread-top">
                          <span className="sp-who">{whoOf(t.ticket)}</span>
                          <span className="sp-when">{whenShort(t.at)}</span>
                        </span>
                        <span className="sp-what">
                          {t.ticket?.summary ??
                            `${t.conversation?.turns ?? 0} ${t.conversation?.turns === 1 ? "message" : "messages"}`}
                        </span>
                        <span className={`word ${w.tone}`}>{w.word}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="sp-thread-view" aria-live="polite">
                {selected && (
                  <p className="sp-via">
                    {whoOf(ticket)} ·{" "}
                    {conversation
                      ? "via the widget"
                      : ticket?.channel === "email"
                        ? "by email"
                        : "a ticket"}{" "}
                    ·{" "}
                    {new Date(selected.at).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {conversation &&
                      ` · ${conversation.turns} ${conversation.turns === 1 ? "turn" : "turns"} · €${Number.parseFloat(conversation.cost_eur).toFixed(4)}`}
                  </p>
                )}
                {conversation && transcript.length === 0 && (
                  <p className="sp-fine">
                    {s.transcriptOf === conversation.id
                      ? "Nothing was said in this conversation."
                      : "Reading the conversation…"}
                  </p>
                )}
                <ol className="sp-msgs">
                  {transcript.map((m) => (
                    <li key={m.id} className={`sp-msg ${m.role}`}>
                      {/* Customer words are text under discussion — rendered, never acted on. */}
                      <p className="sp-msg-text">{m.text}</p>
                      <p className="sp-msg-meta">
                        {m.role === "assistant" ? "Assistant · automated" : "Visitor"} ·{" "}
                        {whenShort(m.at)}
                      </p>
                    </li>
                  ))}
                </ol>

                {emails.length > 0 && (
                  <ol className="sp-msgs sp-emails" aria-label="Emails">
                    {emails.map((m) => (
                      <li
                        key={m.id}
                        className={`sp-msg ${m.direction === "inbound" ? "customer" : "assistant"}`}
                      >
                        {m.subject && <p className="sp-msg-subject">{m.subject}</p>}
                        {/* An email's words are text under discussion — rendered, never acted on (rule 24). */}
                        <p className="sp-msg-text">{m.body}</p>
                        {m.truncated && (
                          <p className="sp-fine">
                            This email was longer than I keep; I kept the first 20,000 characters.
                          </p>
                        )}
                        <p className="sp-msg-meta">
                          {m.direction === "inbound"
                            ? (m.from_name ?? m.from_address)
                            : "You, by email"}{" "}
                          · {whenShort(m.at)}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {ticket?.suppressed_address && (
                  <p className="sp-box sp-refused">
                    <span className="word alarm">replies refused</span> This address is on your
                    suppression list (they unsubscribed or asked to be erased), so I won&rsquo;t
                    send it anything. The ticket is here so you know they wrote.
                  </p>
                )}

                {ticket && (
                  <div className="sp-box sp-handed">
                    <p className="sp-box-label">
                      <span className={`word ${ticket.status === "open" ? "drift" : "ok"}`}>
                        handed to you · {REASON_WORD[ticket.reason]}
                      </span>
                    </p>
                    {!conversation && <p className="sp-box-title">{ticket.summary}</p>}
                    {ticket.status === "open" ? (
                      <>
                        <label className="cs-label" htmlFor={`sp-t-${ticket.id}`}>
                          What you told them — kept on record, not sent
                        </label>
                        <textarea
                          id={`sp-t-${ticket.id}`}
                          className="sp-textarea"
                          rows={3}
                          value={typed}
                          onChange={(e) =>
                            setState({
                              ...s,
                              ticketAnswers: { ...s.ticketAnswers, [ticket.id]: e.target.value },
                            })
                          }
                        />
                        <div className="sp-row">
                          <button
                            type="button"
                            className="next"
                            disabled={s.busy}
                            onClick={() =>
                              void act(
                                {
                                  action: "resolve_ticket",
                                  ticket_id: ticket.id,
                                  status: "answered",
                                  answer: typed,
                                },
                                typed.trim() === ""
                                  ? "Marked answered. Next time, write what you said — it can become an approved answer."
                                  : "Marked answered, with your words on record.",
                              )
                            }
                          >
                            I answered them <span aria-hidden="true">→</span>
                          </button>
                          <button
                            type="button"
                            className="prop-btn"
                            disabled={s.busy || typed.trim() === ""}
                            onClick={() =>
                              void act(
                                {
                                  action: "propose_custom",
                                  question: ticket.summary,
                                  answer: typed,
                                },
                                "Proposed as an answer. Approve it in the queue, then publish it here.",
                              )
                            }
                          >
                            Propose as an answer
                          </button>
                          <button
                            type="button"
                            className="prop-btn quiet"
                            disabled={s.busy}
                            onClick={() =>
                              void act(
                                {
                                  action: "resolve_ticket",
                                  ticket_id: ticket.id,
                                  status: "closed",
                                },
                                "Closed.",
                              )
                            }
                          >
                            Close
                          </button>
                        </div>
                        <p className="sp-fine">
                          You reply to them yourself; this screen sends nothing.
                        </p>
                      </>
                    ) : (
                      ticket.answer && <p className="sp-box-title">You said: {ticket.answer}</p>
                    )}
                  </div>
                )}

                {ticket && !conversation && (
                  <div className="sp-erase">
                    {/* GDPR erasure (rule 22): irreversible, so it asks twice. */}
                    <button
                      type="button"
                      className={s.confirmErase === ticket.id ? "prop-btn" : "prop-btn quiet"}
                      disabled={s.busy}
                      onClick={() =>
                        s.confirmErase === ticket.id
                          ? void act(
                              { action: "erase_ticket", ticket_id: ticket.id },
                              "The ticket and its emails are erased. The log records only that it happened.",
                            )
                          : setState({ ...s, confirmErase: ticket.id })
                      }
                    >
                      {s.confirmErase === ticket.id ? "Erase permanently" : "Erase this ticket"}
                    </button>
                    {s.confirmErase === ticket.id && (
                      <span className="sp-fine">
                        It cannot be undone. The log keeps only that it happened.
                      </span>
                    )}
                  </div>
                )}

                {conversation && (
                  <div className="sp-erase">
                    {/* GDPR erasure (rule 22): irreversible, so it asks twice. */}
                    <button
                      type="button"
                      className={s.confirmErase === conversation.id ? "prop-btn" : "prop-btn quiet"}
                      disabled={s.busy}
                      onClick={() =>
                        s.confirmErase === conversation.id
                          ? void act(
                              { action: "erase_conversation", conversation_id: conversation.id },
                              "The conversation and its ticket are erased. The log records only that it happened.",
                            )
                          : setState({ ...s, confirmErase: conversation.id })
                      }
                    >
                      {s.confirmErase === conversation.id
                        ? "Erase permanently"
                        : "Erase this conversation"}
                    </button>
                    {s.confirmErase === conversation.id && (
                      <span className="sp-fine">
                        It cannot be undone. The log keeps only that it happened.
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── the widget ── */}
      <section className="cs sp-widget" aria-labelledby="sp-widget-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">The widget</p>
            <h2 className="cs-title" id="sp-widget-title">
              An assistant that says it is one
            </h2>
          </div>
          <Link className="prop-btn sp-small" href="/support/test">
            Test the widget <span aria-hidden="true">→</span>
          </Link>
        </header>
        <div className="cs-body">
          {s.settings ? (
            <>
              <p className="sp-prose">
                Paste this one line into your website. Visitors see an assistant that introduces
                itself as automated, answers only from the approved list above, and hands over to
                you the moment they ask for a person.
              </p>
              <pre className="sp-snippet">{s.settings.snippet}</pre>
              <div className="sp-row">
                <button
                  type="button"
                  className="prop-btn"
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
                <span className="sp-fine">
                  The key is public by design — it only says which business a conversation belongs
                  to. It is not a login.
                </span>
              </div>
            </>
          ) : (
            <>
              <p className="sp-prose">
                Not enabled yet. Enabling creates the widget&apos;s public key; nothing is said to
                anyone until you approve answers.
              </p>
              <button
                type="button"
                className="next"
                disabled={s.busy}
                onClick={() => void act({ action: "enable" }, "Enabled. Now approve some answers.")}
              >
                Enable the assistant <span aria-hidden="true">→</span>
              </button>
            </>
          )}
        </div>
        <footer className="cs-foot">
          The assistant reads approved answers and nothing else: not your profile, not your numbers,
          not your connections, and it cannot change anything.
        </footer>
      </section>

      {/* ── the support inbox (P4-09) ── */}
      <section className="cs sp-widget" aria-labelledby="sp-inbox-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Support email</p>
            <h2 className="cs-title" id="sp-inbox-title">
              Emails to your support address become tickets here
            </h2>
          </div>
        </header>
        <div className="cs-body">
          {!s.settings ? (
            <p className="sp-prose">Enable the assistant above first; that creates your address.</p>
          ) : s.settings.inbound_address ? (
            <>
              <p className="sp-prose">
                Forward your support mailbox to this address. Every email becomes a ticket here,
                threaded with its replies. Nothing is answered automatically: you see each one, and
                nothing goes back without your click.
              </p>
              <pre className="sp-snippet">{s.settings.inbound_address}</pre>
              <div className="sp-row">
                <button
                  type="button"
                  className="prop-btn"
                  disabled={s.busy}
                  onClick={() =>
                    void act(
                      { action: "rotate_inbound" },
                      "New address. Mail to the old one is dropped from now on, so update your forwarding.",
                    )
                  }
                >
                  Change the address
                </button>
                <span className="sp-fine">
                  Only someone who knows it can file a ticket. Change it if it leaks.
                </span>
              </div>
            </>
          ) : (
            <p className="sp-prose">
              Not set up yet: support email needs the inbound domain and the webhook connected in
              Resend. Until then no email reaches this screen.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

/** Who a thread is from, in words: the emailer's name or address, else a widget visitor. */
function whoOf(ticket: Ticket | null): string {
  if (ticket?.from) return ticket.from;
  return ticket?.channel === "email" ? "Emailer" : "Visitor";
}

function EntryRow({ e, busy, onRetire }: { e: Entry; busy: boolean; onRetire?: () => void }) {
  const fromCustomers = e.source_keys.some((k) => k.startsWith("faq:ticket:"));
  return (
    <li className="sp-entry">
      <span className="sp-entry-id">{shortId(e.id)}</span>
      <div className="sp-entry-main">
        <p className="sp-entry-q">{e.question}</p>
        <p className="sp-entry-a">{e.answer}</p>
        <p className="sp-entry-src">
          from{" "}
          {fromCustomers ? `${e.source_keys.length} customers who asked` : e.source_keys.join(", ")}
        </p>
      </div>
      <div className="sp-entry-side">
        <span className="sp-entry-date">pub. {dayWord(e.published_at)}</span>
        {onRetire && (
          <button type="button" className="prop-btn quiet" disabled={busy} onClick={onRetire}>
            Retire
          </button>
        )}
      </div>
    </li>
  );
}
