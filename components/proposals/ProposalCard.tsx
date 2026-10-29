"use client";

// One proposal, on a phone — idea 53 (I-53.5). The page a phone alert
// opens: /proposals/<id>.
//
// It reads top to bottom as the queue's mobile card does (ux-spec §8):
// what changes, the gain as a range, the worst case, whether it can be
// undone, and what it was checked against (the owner's 13.5 answer). Then
// Approve and Decline, equal in weight, through the queue's own decision
// endpoint (PUT /api/proposals) — the same checks, the same decision log,
// the yes recorded with the signed-in owner's name (rule 12). The alert
// itself never approves anything; this card is the only place a phone
// says yes. An answered, expired or held-back proposal says so, with no
// buttons. Signed out, the card sends the owner through sign-in and back.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EmergencyStop } from "../execution/EmergencyStop";
import type { CardLimit, CardProposal } from "./card-model";
import { cardState, gainLine, limitLines, undoLine, worstCase } from "./card-model";
import type { ReasonChip } from "./queue-model";
import {
  REASON_CHIPS,
  activeChip,
  applyReasonChip,
  approvalNote,
  changeLines,
  consequence,
  effectSpan,
  shortRef,
} from "./queue-model";
import "../../app/queue.css";

interface CardData {
  proposal: CardProposal & {
    module: string;
    execute_not_before: string | null;
    action: CardProposal["action"] & {
      detail?: { sending?: unknown; publish_at?: unknown; execute_on_approval?: unknown };
    };
  };
  business: string | null;
  limits: CardLimit[] | null;
  signed_in: boolean;
  /** Idea 52: why this role can't decide here, or null when it may. */
  decide_why?: string | null;
}

type Phase =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "missing" }
  | { phase: "error" }
  | { phase: "ready"; data: CardData };

const moduleWord = (m: string) => m.replace(/_/g, " ");

export function ProposalCard({ id }: { id: string }) {
  const [state, setState] = useState<Phase>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [halted, setHalted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/proposals/${id}`);
      if (res.status === 401) return setState({ phase: "signedout" });
      if (res.status === 404) return setState({ phase: "missing" });
      if (!res.ok) return setState({ phase: "error" });
      setState({ phase: "ready", data: (await res.json()) as CardData });
    } catch {
      setState({ phase: "error" });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onHaltState = useCallback((h: boolean) => setHalted(h), []);
  const signIn = `/login?next=${encodeURIComponent(`/proposals/${id}`)}`;

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/proposals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [id],
        decision,
        ...(decision === "reject" ? { reason: reason.trim() } : {}),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      decided?: string[];
      failed?: { error: string }[];
      error?: string;
    };
    setBusy(false);
    if (res.status === 401) return setState({ phase: "signedout" });
    if (!j.decided?.includes(id)) {
      setNotice(`Not recorded: ${j.failed?.[0]?.error ?? j.error ?? "something went wrong"}.`);
      return;
    }
    setDeclining(false);
    await load();
  };

  const masthead = (business: string | null) => (
    <header className="q-mast q-mast-m">
      <div className="q-mast-row">
        <Link href="/watch" className="q-wordmark">
          SYB
        </Link>
        <span className="q-mast-meta">{business ? `${business} · ` : ""}Decision</span>
      </div>
      <div className="q-mast-row">
        <EmergencyStop variant="masthead" onState={onHaltState} />
      </div>
    </header>
  );

  if (state.phase === "loading") {
    return (
      <div className="q-app q-m">
        <p className="q-loading">Reading the proposal…</p>
      </div>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">SYB</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">proposal</span>
            <h1 className="auth-title">Sign in to decide.</h1>
            <p className="auth-copy">
              Approving or declining is recorded with your name on it, so it needs you signed in on
              this device. I&rsquo;ll bring you back to this proposal afterwards.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href={signIn}>
              Sign in
            </Link>
          </section>
        </div>
      </main>
    );
  }

  if (state.phase === "missing" || state.phase === "error") {
    return (
      <div className="q-app q-m">
        {masthead(null)}
        <main className="q-m-main">
          <section className="q-sheet q-empty">
            <h1 className="q-title">
              {state.phase === "missing"
                ? "There's no such proposal here."
                : "The proposal didn't load."}
            </h1>
            <p className="q-prose">
              {state.phase === "missing"
                ? "The link may be for another business, or wrong."
                : "Something went wrong on our side. Refresh to try again."}{" "}
              <Link href="/proposals">Open the queue</Link>
            </p>
          </section>
        </main>
      </div>
    );
  }

  const { data } = state;
  const p = data.proposal;
  const st = cardState(p, new Date());
  const gain = gainLine(p);
  const undo = undoLine(p);
  const lines = changeLines(p.action);
  const titleId = `card-${p.id}`;
  const chip = activeChip(reason);
  const publishAt =
    typeof p.action.detail?.publish_at === "string" ? p.action.detail.publish_at : null;
  const runAt =
    publishAt ?? (p.action.detail?.execute_on_approval === true ? new Date().toISOString() : null);

  return (
    <div className="q-app q-m">
      {masthead(data.business)}
      <main className="q-m-main">
        {notice && (
          <p className="q-notice" role="alert">
            {notice}
          </p>
        )}
        <article className="q-sheet q-mcard" aria-labelledby={titleId}>
          <header className="q-mcard-head">
            <p className="q-ref">
              {shortRef(p.id)} · {moduleWord(p.module)}
            </p>
            <h1 id={titleId} className="q-title">
              {p.action.summary}
            </h1>
          </header>

          <section className="q-msec">
            <h2 className="q-mlabel">What changes</h2>
            {lines ? (
              <dl className="q-mlines">
                {lines.map((l) => (
                  <div key={l.line} className="q-mline">
                    <dt>{l.line}</dt>
                    <dd className="fig">
                      {l.before} <span aria-hidden="true">→</span>
                      <span className="sr-only"> becomes </span> {l.after}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="q-nolines">It states no before and after: the change is the title.</p>
            )}
          </section>

          <section className="q-msec">
            <h2 className="q-mlabel">Expected, {effectSpan(p.action)} · estimated</h2>
            {gain ? (
              <p className="q-fig fig">{gain}</p>
            ) : (
              <p className="q-effect-words">No money range was forecast for this one.</p>
            )}
            <p className="q-mono-note">Worst case: {worstCase(p)}</p>
          </section>

          <section className="q-msec">
            <div className="q-rev-row">
              <span className={`word boxed q-revword${undo.reversible ? "" : " q-irrev"}`}>
                {undo.reversible ? "REVERSIBLE" : "IRREVERSIBLE"}
              </span>
              <span className="q-rev-note">{undo.note || undo.word}</span>
            </div>
          </section>

          <section className="q-msec">
            <h2 className="q-mlabel">Checked against your limits</h2>
            {limitLines(data.limits).map((l) => (
              <p key={l} className="q-prose">
                {l}
              </p>
            ))}
          </section>

          {st.kind === "closed" ? (
            <section className="q-mdecide" aria-label="Already answered">
              <p className="q-rev-row">
                <span className="word boxed">{st.word}</span>
                <span className="q-rev-note" role="status">
                  {st.sentence}
                </span>
              </p>
              <Link className="q-btn" href="/proposals">
                Back to the queue <span aria-hidden="true">→</span>
              </Link>
            </section>
          ) : !data.signed_in ? (
            <section className="q-mdecide" aria-label="Your decision">
              <p className="q-approve-note">
                Deciding is recorded with your name, so it needs you signed in.
              </p>
              <Link className="q-btn" href={signIn}>
                Sign in to decide <span aria-hidden="true">→</span>
              </Link>
            </section>
          ) : (
            <section className="q-mdecide" aria-label="Your decision">
              <div className="q-mpair">
                <button
                  type="button"
                  className="q-btn"
                  disabled={busy || Boolean(data.decide_why)}
                  onClick={() => void decide("approve")}
                >
                  {consequence(p.action)} <span aria-hidden="true">→</span>
                </button>
                <button
                  type="button"
                  className="q-btn"
                  disabled={busy || Boolean(data.decide_why)}
                  aria-expanded={declining}
                  onClick={() => setDeclining((d) => !d)}
                >
                  Decline <span aria-hidden="true">→</span>
                </button>
              </div>
              {declining && (
                <div className="q-panel">
                  <p className="q-panel-label" id={`why-${p.id}`}>
                    Why not? One tap is enough
                  </p>
                  <div className="q-chips" role="group" aria-labelledby={`why-${p.id}`}>
                    {REASON_CHIPS.map((c: ReasonChip) => (
                      <button
                        key={c}
                        type="button"
                        className="q-chip"
                        aria-pressed={chip === c}
                        onClick={() => setReason(applyReasonChip(reason, c))}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor={`reason-${p.id}`}>
                    Your reason, in your words
                  </label>
                  <textarea
                    id={`reason-${p.id}`}
                    className="q-text"
                    placeholder="Or say it in a sentence — I learn from it."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <p className="q-panel-foot">
                    Declining: nothing runs and nothing changes. I record it with your reason.
                  </p>
                  <button
                    type="button"
                    className="q-btn q-btn-inline"
                    disabled={busy || Boolean(data.decide_why) || reason.trim() === ""}
                    onClick={() => void decide("reject")}
                  >
                    Record the decline <span aria-hidden="true">→</span>
                  </button>
                </div>
              )}
              <p className="q-approve-note">
                {approvalNote({ runAt, sending: p.action.detail?.sending })}
                {halted && " Everything is stopped right now: nothing runs until you start again."}
              </p>
              {data.decide_why && (
                <p className="q-role-note" role="note">
                  {data.decide_why} You can read everything here.
                </p>
              )}
              <Link className="q-quiet" href="/proposals">
                See the whole queue
              </Link>
            </section>
          )}
        </article>
        <p className="q-m-foot">Nothing runs until you approve it.</p>
      </main>
    </div>
  );
}
