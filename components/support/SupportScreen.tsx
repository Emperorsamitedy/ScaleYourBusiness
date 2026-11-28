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
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "support"
// catalogue; times, dates and figures in the reader's locale. What
// customers wrote, approved answers, ticket summaries and drafts are
// content, shown as they are; the server's own sentences (errors, a send's
// outcome note, a knowledge proposal's summary) arrive in the reader's
// language since L-4c (lib/support-desk/words).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import "../../app/support.css";
import { intlMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { HBars, SegBar } from "../charts/Viz";
import { PageHead } from "../sheet/PageHead";
import { ToolIntro } from "../grow/ToolIntro";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { PhoneLine } from "./PhoneLine";
import { type Reply, ReplyBox } from "./ReplyBox";
import {
  type ConversationStatus,
  type TicketReason,
  type TicketStatus,
  EMAIL_KEPT_CHARS,
  clusterBars,
  conversationWord,
  dayWord,
  reasonWord,
  senderNoteWord,
  standingSegs,
  supportHeadline,
  ticketLine,
  waitingBars,
  waitingTitle,
  whenFull,
  whenShort,
} from "./support-view";
import { Logo } from "../brand/Mark";

interface Settings {
  site_key: string;
  business_name: string;
  rotated_at: string | null;
  snippet: string;
  /** s-<token>@<domain>, or null when no inbound domain is configured. */
  inbound_address: string | null;
  inbound_rotated_at: string | null;
  reply_hours: number | null;
  reply_hours_set_at: string | null;
  notify_owner: boolean;
}

interface Entry {
  id: string;
  question: string;
  answer: string;
  source_keys: string[];
  /** The sources in words (entity names, not ids), from the server. */
  source_words?: string;
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
  /** The customer's name or address, when there is one. */
  from: string | null;
  has_address: boolean;
  /** Review #18: "sender not verified" or "given in chat, not verified" — null when the sender is proven. */
  sender_note: string | null;
  /** The first word of theirs not yet answered; null when we wrote last. */
  waiting_since: string | null;
  last_reply_at: string | null;
}

interface Email {
  id: string;
  direction: "inbound" | "outbound";
  from_address: string;
  from_name: string | null;
  subject: string;
  body: string;
  truncated: boolean;
  /** Inbound only: did the sender pass authentication? Null on our own emails. */
  sender_verified: boolean | null;
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
      replies: Reply[];
      reachable: boolean;
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

/** SYB's own running cost of a conversation, in euros at four decimals: "€0.0123". */
function costWords(costEur: string, locale: AppLocale): string {
  const n = Number.parseFloat(costEur);
  return locale === "en" ? `€${n.toFixed(4)}` : intlMoney(n, "EUR", 4, locale);
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
  const { tr, locale } = useTr("support");
  const t = useTranslations("support");
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
      replies: cur.phase === "ready" ? cur.replies : [],
      reachable: cur.phase === "ready" ? cur.reachable : false,
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
      const j = (await res.json()) as { emails: Email[]; replies: Reply[]; reachable: boolean };
      if (!live) return;
      setState((cur) =>
        cur.phase === "ready"
          ? {
              ...cur,
              emails: j.emails,
              replies: j.replies,
              reachable: j.reachable,
              emailsOf: wantEmails,
            }
          : cur,
      );
    })();
    return () => {
      live = false;
    };
  }, [wantEmails, haveEmails]);

  if (state.phase === "loading") {
    return (
      <main className="screen sp-screen">
        <PageHead kicker={tr("kicker")} title={tr("loading")} />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">
            <Logo onDark />
          </span>
          <section className="card auth-card">
            <span className="auth-eyebrow">{tr("signedOut.eyebrow")}</span>
            <h1 className="auth-title">{tr("signedOut.title")}</h1>
            <p className="auth-copy">{tr("signedOut.body")}</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/start">
              {tr("signedOut.begin")}
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

  const act = async (
    payload: Record<string, unknown>,
    doneNotice: string | ((json: Record<string, unknown>) => string),
  ) => {
    setState({ ...s, busy: true, notice: null });
    const { ok, json } = await post(payload);
    if (!ok) {
      setState({ ...s, busy: false, notice: json.error ?? tr("failed") });
      return;
    }
    await load();
    const notice = typeof doneNotice === "string" ? doneNotice : doneNotice(json);
    setState((cur) => (cur.phase === "ready" ? { ...cur, notice } : cur));
  };

  const clusterFaq = async () => {
    setState({ ...s, busy: true, notice: null });
    const { ok, json } = await post({ action: "cluster_faq" });
    if (!ok) {
      setState({ ...s, busy: false, notice: json.error ?? tr("failed") });
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
                ? tr("faq.tooFew", { count: outcome.questions })
                : outcome.proposal_id
                  ? tr("faq.proposed")
                  : outcome.clusters.length === 0
                    ? tr("faq.none")
                    : tr("faq.unanswered"),
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
  const replies = ticket && s.emailsOf === ticket.id ? s.replies : [];
  const typed = ticket ? (s.ticketAnswers[ticket.id] ?? "") : "";
  const now = new Date();
  const replyHours = s.settings?.reply_hours ?? null;
  const standing = standingSegs(
    s.tickets,
    (k) =>
      k === "waiting"
        ? tr("viz.awaiting")
        : k === "replied"
          ? tr("ticket.youReplied")
          : k === "answered"
            ? tr("ticket.answeredFlag")
            : tr("ticket.closedFlag"),
    locale,
  );
  const waiting = waitingBars(s.tickets, now, replyHours, tr, locale);
  const waitingCap =
    waiting.total > waiting.rows.length
      ? tr("viz.waitingTop", {
          shown: num(waiting.rows.length, 0, locale),
          total: num(waiting.total, 0, locale),
        })
      : tr("viz.waiting");
  const clusters = clusterBars(s.faq?.clusters ?? []);

  return (
    <main className="screen sp-screen">
      <PageHead kicker={tr("kicker")} title={supportHeadline(publicEntries.length, tr)}>
        <div className="sp-counts">
          <span>
            {t.rich("counts", {
              b: (c) => <b>{c}</b>,
              count: s.conversations.length,
              conversations: num(s.conversations.length, 0, locale),
              handed: num(s.tickets.length, 0, locale),
              waiting: num(openTickets.length, 0, locale),
            })}
          </span>
          <Link className="ghost sp-test" href="/support/test">
            {tr("testWidget")} <span aria-hidden="true">→</span>
          </Link>
        </div>
      </PageHead>
      <ToolIntro tool="messages" />

      {s.notice && (
        <p className="sp-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      {/* ── tickets and conversations (P4-11) ── */}
      <section className="cs sp-convos" aria-labelledby="sp-convos-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">
              {tr("convos.label", {
                tickets: num(s.tickets.length, 0, locale),
                conversations: num(s.conversations.length, 0, locale),
              })}
            </p>
            <h2 className="cs-title" id="sp-convos-title">
              {waitingTitle(openTickets.length, tr)}
            </h2>
          </div>
          <p className="cs-meta sp-sla-meta">
            {s.settings?.reply_hours
              ? tr("sla.yourTime", { hours: num(s.settings.reply_hours, 0, locale) })
              : tr("sla.unset")}
            <br />
            {tr("sla.clock")}
          </p>
        </header>
        {threads.length === 0 ? (
          <div className="cs-body">
            <p className="sp-empty">{tr("convos.empty")}</p>
          </div>
        ) : (
          <>
            {standing.length > 0 && (
              <div className="sp-viz">
                <p className="vz-cap">{tr("viz.byStanding")}</p>
                <SegBar segs={standing} label={tr("viz.byStanding")} />
                {waiting.rows.length > 0 && (
                  <>
                    <p className="vz-cap">{waitingCap}</p>
                    <HBars
                      label={waitingCap}
                      {...(replyHours === null
                        ? {}
                        : {
                            refAt: replyHours,
                            refLabel: tr("sla.yourTime", { hours: num(replyHours, 0, locale) }),
                          })}
                      rows={waiting.rows.map((w) => ({
                        key: w.key,
                        label: w.who,
                        note: w.channel,
                        value: w.hours,
                        display: w.display,
                        tone: w.tone,
                      }))}
                    />
                  </>
                )}
              </div>
            )}
            <div className="sp-table-wrap">
              <table className="rt rt-stack sp-tickets">
                <thead>
                  <tr>
                    <th scope="col">{tr("col.channel")}</th>
                    <th scope="col">{tr("col.who")}</th>
                    <th scope="col">{tr("col.what")}</th>
                    <th scope="col" className="num">
                      {tr("col.waited")}
                    </th>
                    <th scope="col">{tr("col.against")}</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.map((th) => {
                    const on = selected?.key === th.key;
                    const line = th.ticket
                      ? ticketLine(th.ticket, now, s.settings?.reply_hours ?? null, tr, locale)
                      : null;
                    const w = conversationWord(
                      th.conversation?.status ?? "escalated",
                      th.ticket,
                      tr,
                    );
                    const turns = th.conversation?.turns ?? 0;
                    return (
                      <tr key={th.key} className={on ? "on" : undefined}>
                        <td className="src" data-label={tr("col.channel")}>
                          {line?.channel ?? tr("channel.chat")}
                        </td>
                        <th scope="row">
                          <button
                            type="button"
                            className="sp-pick"
                            aria-pressed={on}
                            onClick={() => setState({ ...s, open: th.key, confirmErase: null })}
                          >
                            {line ? line.who : tr("who.visitor")}
                          </button>
                          {th.ticket?.sender_note && (
                            <span className="sp-fine">
                              {" "}
                              {senderNoteWord(th.ticket.sender_note, tr)}
                            </span>
                          )}
                        </th>
                        <td className="sp-what" data-label={tr("col.what")}>
                          {line?.what ??
                            tr("convos.messages", {
                              count: turns,
                              n: num(turns, 0, locale),
                              when: whenShort(th.at, undefined, locale),
                            })}
                        </td>
                        <td className="num" data-label={tr("col.waited")}>
                          {line?.waited ?? ""}
                        </td>
                        <td data-label={tr("col.against")}>
                          {line ? (
                            <>
                              <span className={`flag ${line.tone}`}>{line.flag}</span>
                              {line.detail && <span className="sp-sla-fig"> {line.detail}</span>}
                            </>
                          ) : (
                            <span className={`flag ${w.tone}`}>{w.word}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="sp-split" aria-live="polite">
              <div className="sp-thread-view">
                {selected && (
                  <p className="sp-via">
                    {whoOf(ticket, tr)}
                    {ticket?.sender_note && ` (${senderNoteWord(ticket.sender_note, tr)})`} ·{" "}
                    {conversation
                      ? tr("via.widget")
                      : ticket?.channel === "email"
                        ? tr("via.email")
                        : tr("via.ticket")}{" "}
                    · {whenFull(selected.at, locale)}
                    {conversation &&
                      ` · ${tr("via.turns", {
                        count: conversation.turns,
                        n: num(conversation.turns, 0, locale),
                        cost: costWords(conversation.cost_eur, locale),
                      })}`}
                  </p>
                )}
                {conversation && transcript.length === 0 && (
                  <p className="sp-fine">
                    {s.transcriptOf === conversation.id
                      ? tr("transcript.empty")
                      : tr("transcript.reading")}
                  </p>
                )}
                <ol className="sp-msgs">
                  {transcript.map((m) => (
                    <li key={m.id} className={`sp-msg ${m.role}`}>
                      {/* Customer words are text under discussion — rendered, never acted on. */}
                      <p className="sp-msg-text">{m.text}</p>
                      <p className="sp-msg-meta">
                        {m.role === "assistant" ? tr("msg.assistant") : tr("msg.visitor")} ·{" "}
                        {whenShort(m.at, undefined, locale)}
                      </p>
                    </li>
                  ))}
                </ol>

                {emails.length > 0 && (
                  <ol className="sp-msgs sp-emails" aria-label={tr("emails.aria")}>
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
                            {tr("emails.truncated", { chars: num(EMAIL_KEPT_CHARS, 0, locale) })}
                          </p>
                        )}
                        <p className="sp-msg-meta">
                          {m.direction === "inbound"
                            ? (m.from_name ?? m.from_address)
                            : tr("emails.you")}
                          {m.sender_verified === false && ` · ${tr("senderNote.notVerified")}`} ·{" "}
                          {whenShort(m.at, undefined, locale)}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {ticket?.suppressed_address && (
                  <p className="sp-box sp-refused">
                    <span className="word alarm">{tr("refused.word")}</span> {tr("refused.body")}
                  </p>
                )}
              </div>
              <div className="sp-thread-act">
                {ticket &&
                  s.emailsOf === ticket.id &&
                  (ticket.status === "open" ||
                    replies.some((r) => ["approved", "sending"].includes(r.status))) && (
                    <ReplyBox
                      ticketId={ticket.id}
                      replies={replies}
                      reachable={s.reachable}
                      businessName={s.settings?.business_name ?? "this business"}
                      busy={s.busy}
                      act={act}
                    />
                  )}

                {ticket && (
                  <div className="sp-box sp-handed">
                    <p className="sp-box-label">
                      <span className={`word ${ticket.status === "open" ? "drift" : "ok"}`}>
                        {tr("ticket.handed", { reason: reasonWord(ticket.reason, tr) })}
                      </span>
                    </p>
                    {!conversation && <p className="sp-box-title">{ticket.summary}</p>}
                    {ticket.status === "open" ? (
                      <>
                        <label className="cs-label" htmlFor={`sp-t-${ticket.id}`}>
                          {tr("ticket.answerLabel")}
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
                                  ? tr("notice.answeredBlank")
                                  : tr("notice.answeredWords"),
                              )
                            }
                          >
                            {tr("ticket.answered")} <span aria-hidden="true">→</span>
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
                                tr("notice.proposedAnswer"),
                              )
                            }
                          >
                            {tr("ticket.propose")}
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
                                tr("notice.closed"),
                              )
                            }
                          >
                            {tr("ticket.close")}
                          </button>
                        </div>
                        <p className="sp-fine">{tr("ticket.sendsNothing")}</p>
                      </>
                    ) : (
                      ticket.answer && (
                        <p className="sp-box-title">
                          {tr("ticket.youSaid", { answer: ticket.answer })}
                        </p>
                      )
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
                              tr("notice.erasedTicket"),
                            )
                          : setState({ ...s, confirmErase: ticket.id })
                      }
                    >
                      {s.confirmErase === ticket.id ? tr("erase.confirm") : tr("erase.ticket")}
                    </button>
                    {s.confirmErase === ticket.id && (
                      <span className="sp-fine">{tr("erase.cannotUndo")}</span>
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
                              tr("notice.erasedConversation"),
                            )
                          : setState({ ...s, confirmErase: conversation.id })
                      }
                    >
                      {s.confirmErase === conversation.id
                        ? tr("erase.confirm")
                        : tr("erase.conversation")}
                    </button>
                    {s.confirmErase === conversation.id && (
                      <span className="sp-fine">{tr("erase.cannotUndo")}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <div className="sp-grid">
        {/* ── what it may say ── */}
        <section className="cs sp-answers" id="sp-answers" aria-labelledby="sp-answers-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">
                {tr("answers.label", { count: num(publicEntries.length, 0, locale) })}
              </p>
              <h2 className="cs-title" id="sp-answers-title">
                {tr("answers.title")}
              </h2>
            </div>
            <button
              type="button"
              className="prop-btn sp-small"
              aria-expanded={s.writing}
              aria-controls="sp-write"
              onClick={() => setState({ ...s, writing: !s.writing })}
            >
              {s.writing ? tr("answers.close") : tr("answers.write")}
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
                    tr("notice.proposed"),
                  );
                }}
              >
                <label className="cs-label" htmlFor="sp-q">
                  {tr("answers.question")}
                </label>
                <input
                  id="sp-q"
                  className="sp-input"
                  value={s.question}
                  onChange={(e) => setState({ ...s, question: e.target.value })}
                />
                <label className="cs-label" htmlFor="sp-a">
                  {tr("answers.answer")}
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
                    {tr("answers.propose")}
                  </button>
                  <span className="sp-fine">{tr("answers.queueFirst")}</span>
                </div>
              </form>
            )}

            {s.publishable.map((p) => (
              <div key={p.id} className="sp-box">
                <p className="sp-box-label">
                  <span className="word ok">{tr("answers.notPublic")}</span>
                </p>
                <p className="sp-box-title">{p.summary}</p>
                <div className="sp-row">
                  <button
                    type="button"
                    className="prop-btn"
                    disabled={s.busy}
                    onClick={() =>
                      void act({ action: "publish", proposal_id: p.id }, tr("notice.published"))
                    }
                  >
                    {tr("answers.publish")}
                  </button>
                </div>
              </div>
            ))}

            {clusters.length > 0 && (
              <div className="sp-clusters">
                <p className="vz-cap">{tr("viz.clusters")}</p>
                <HBars
                  label={tr("viz.clusters")}
                  rows={clusters.map((c) => ({
                    key: c.key,
                    label: c.question,
                    value: c.count,
                    display: num(c.count, 0, locale),
                    tone: "ink" as const,
                  }))}
                />
              </div>
            )}

            {unanswered.map((c) => (
              <div key={c.question} className="sp-box">
                <p className="sp-box-label">
                  <span className="word drift">
                    {tr("answers.askedTimes", {
                      count: c.members.length,
                      n: num(c.members.length, 0, locale),
                    })}
                  </span>
                </p>
                <p className="sp-box-title">{c.question}</p>
                <p className="sp-fine">{tr("answers.answerOne")}</p>
              </div>
            ))}

            {s.knowledge.length === 0 && !s.writing && (
              <p className="sp-empty">{tr("answers.empty")}</p>
            )}

            {publicEntries.length > 0 && (
              <ul className="sp-entries">
                {publicEntries.map((e) => (
                  <EntryRow
                    key={e.id}
                    e={e}
                    busy={s.busy}
                    onRetire={() =>
                      void act({ action: "retire", entry_id: e.id }, tr("notice.retired"))
                    }
                  />
                ))}
              </ul>
            )}
            {retired.length > 0 && (
              <>
                <p className="cs-label sp-gap">{tr("answers.retiredLabel")}</p>
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
              onClick={() => void act({ action: "propose_knowledge" }, tr("notice.proposed"))}
            >
              {tr("answers.fromFacts")}
            </button>
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy}
              onClick={() => void clusterFaq()}
            >
              {tr("answers.cluster")}
            </button>
          </footer>
        </section>

        <div className="sp-side">
          {/* ── the widget ── */}
          <section className="cs sp-widget" aria-labelledby="sp-widget-title">
            <header className="cs-head">
              <div>
                <p className="cs-label">{tr("widget.label")}</p>
                <h2 className="cs-title" id="sp-widget-title">
                  {tr("widget.title")}
                </h2>
              </div>
              <Link className="prop-btn sp-small" href="/support/test">
                {tr("testWidget")} <span aria-hidden="true">→</span>
              </Link>
            </header>
            <div className="cs-body">
              {s.settings ? (
                <>
                  <p className="sp-prose">{tr("widget.paste")}</p>
                  <pre className="sp-snippet">{s.settings.snippet}</pre>
                  <div className="sp-row">
                    <button
                      type="button"
                      className="prop-btn"
                      disabled={s.busy}
                      onClick={() => void act({ action: "rotate" }, tr("notice.rotated"))}
                    >
                      {tr("widget.rotate")}
                    </button>
                    <span className="sp-fine">{tr("widget.keyPublic")}</span>
                  </div>
                </>
              ) : (
                <>
                  <p className="sp-prose">{tr("widget.notEnabled")}</p>
                  <button
                    type="button"
                    className="next"
                    disabled={s.busy}
                    onClick={() => void act({ action: "enable" }, tr("notice.enabled"))}
                  >
                    {tr("widget.enable")} <span aria-hidden="true">→</span>
                  </button>
                </>
              )}
            </div>
            <footer className="cs-foot">{tr("widget.foot")}</footer>
          </section>

          {/* ── the support inbox (P4-09) ── */}
          <section className="cs sp-widget" aria-labelledby="sp-inbox-title">
            <header className="cs-head">
              <div>
                <p className="cs-label">{tr("inbox.label")}</p>
                <h2 className="cs-title" id="sp-inbox-title">
                  {tr("inbox.title")}
                </h2>
              </div>
            </header>
            <div className="cs-body">
              {!s.settings ? (
                <p className="sp-prose">{tr("inbox.enableFirst")}</p>
              ) : s.settings.inbound_address ? (
                <>
                  <p className="sp-prose">{tr("inbox.forward")}</p>
                  <pre className="sp-snippet">{s.settings.inbound_address}</pre>
                  <div className="sp-row">
                    <button
                      type="button"
                      className="prop-btn"
                      disabled={s.busy}
                      onClick={() =>
                        void act({ action: "rotate_inbound" }, tr("notice.rotatedInbound"))
                      }
                    >
                      {tr("inbox.change")}
                    </button>
                    <span className="sp-fine">{tr("inbox.onlyKnown")}</span>
                  </div>
                </>
              ) : (
                <p className="sp-prose">{tr("inbox.notSetUp")}</p>
              )}
            </div>
          </section>
          {s.settings && <ReplyTime settings={s.settings} busy={s.busy} act={act} />}
          {/* P6-02: the phone line — its calls, messages and transcripts. */}
          <PhoneLine />
        </div>
      </div>
    </main>
  );
}

/**
 * P4-11: the owner's own reply time — stated here, stored with when, and
 * never defaulted. The ticket list measures against it in clock hours.
 */
function ReplyTime({
  settings,
  busy,
  act,
}: {
  settings: Settings;
  busy: boolean;
  act: (
    payload: Record<string, unknown>,
    notice: string | ((json: Record<string, unknown>) => string),
  ) => Promise<void>;
}) {
  const { tr, locale } = useTr("support");
  const [hours, setHours] = useState(settings.reply_hours ? String(settings.reply_hours) : "");
  const n = Number(hours);
  const valid = /^\d+$/.test(hours.trim()) && n >= 1 && n <= 720;
  return (
    <section className="cs sp-widget" id="sp-time" aria-labelledby="sp-time-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{tr("time.label")}</p>
          <h2 className="cs-title" id="sp-time-title">
            {settings.reply_hours
              ? tr("time.title", {
                  hours: settings.reply_hours,
                  n: num(settings.reply_hours, 0, locale),
                })
              : tr("sla.unset")}
          </h2>
        </div>
      </header>
      <div className="cs-body">
        <form
          className="sp-row sp-time"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            void act(
              { action: "set_reply_hours", hours: n },
              tr("notice.savedHours", { hours: num(n, 0, locale) }),
            );
          }}
        >
          <label htmlFor="sp-hours">{tr("time.within")}</label>
          <input
            id="sp-hours"
            className="sp-input sp-hours"
            inputMode="numeric"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <span>{tr("time.hours")}</span>
          <button className="act" disabled={busy || !valid}>
            {tr("time.save")}
          </button>
          {settings.reply_hours && (
            <button
              type="button"
              className="act"
              disabled={busy}
              onClick={() =>
                void act({ action: "set_reply_hours", hours: null }, tr("notice.cleared"))
              }
            >
              {tr("time.clear")}
            </button>
          )}
        </form>
        <p className="sp-fine">
          {tr("time.fine")}
          {settings.reply_hours_set_at &&
            ` ${tr("time.setAt", { when: whenShort(settings.reply_hours_set_at, undefined, locale) })}`}
        </p>
        <label className="sp-row sp-check">
          <input
            type="checkbox"
            checked={settings.notify_owner}
            disabled={busy}
            onChange={(e) =>
              void act(
                { action: "set_notify", on: e.target.checked },
                e.target.checked ? tr("notice.notifyOn") : tr("notice.notifyOff"),
              )
            }
          />
          <span>{tr("time.notify")}</span>
        </label>
      </div>
    </section>
  );
}

/** Who a thread is from, in words: the emailer's name or address, else a widget visitor. */
function whoOf(ticket: Ticket | null, tr: Tr): string {
  if (ticket?.from) return ticket.from;
  if (!ticket) return tr("who.visitor");
  return ticket.has_address ? tr("who.customer") : tr("who.visitorNoAddress");
}

function EntryRow({ e, busy, onRetire }: { e: Entry; busy: boolean; onRetire?: () => void }) {
  const { tr, locale } = useTr("support");
  const fromCustomers = e.source_keys.some((k) => k.startsWith("faq:ticket:"));
  return (
    <li className="sp-entry">
      <span className="sp-entry-id">{shortId(e.id)}</span>
      <div className="sp-entry-main">
        <p className="sp-entry-q">{e.question}</p>
        <p className="sp-entry-a">{e.answer}</p>
        <p className="sp-entry-src">
          {fromCustomers
            ? tr("entry.fromCustomers", {
                count: e.source_keys.length,
                n: num(e.source_keys.length, 0, locale),
              })
            : tr("entry.from", { sources: e.source_words ?? e.source_keys.join(", ") })}
        </p>
      </div>
      <div className="sp-entry-side">
        <span className="sp-entry-date">
          {tr("entry.published", { date: dayWord(e.published_at, locale) })}
        </span>
        {onRetire && (
          <button type="button" className="prop-btn quiet" disabled={busy} onClick={onRetire}>
            {tr("entry.retire")}
          </button>
        )}
      </div>
    </li>
  );
}
