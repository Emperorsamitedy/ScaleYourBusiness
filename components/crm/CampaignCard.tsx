"use client";

// One approved campaign on /customers — P4-16's draft, and since P4-15 its
// send: the email as drafted, the owner's approval of THAT email (labelled
// irreversible first: a sent email can't be recalled), and then where the
// send stands — counted, refused by reason, unknowns said plainly, and the
// gate holding it in words. Nothing here sends by itself: approving the
// email asks the engine to send it, and every gate still applies.

import { useState } from "react";
import Link from "next/link";
import { num } from "../sheet/num";
import type { ReadbackView, SendView } from "./campaign-view";
import {
  countRows,
  measuredSentence,
  phaseFlag,
  readbackFlag,
  readbackRows,
  refusalLines,
  sendSentence,
  unknownLine,
} from "./campaign-view";

export interface CampaignView {
  proposal_id: string;
  summary: string;
  label: string | null;
  approved_at: string | null;
  draft: { id: string; title: string; body: string } | null;
  gaps: string[];
  at_send: string[];
  ask: { question_id: string; label: string }[];
  /** P4-15: absent from an older API. */
  recipients?: number;
  irreversible?: boolean;
  send?: SendView;
  /** P4-17: the readback, once it has gone out; absent from an older API. */
  readback?: ReadbackView | null;
}

type Act = (
  payload: Record<string, unknown>,
  done: (j: Record<string, unknown>) => string,
) => Promise<void>;

export function CampaignCard({
  c,
  busy,
  act,
  businessName,
}: {
  c: CampaignView;
  busy: boolean;
  act: Act;
  businessName: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [subject, setSubject] = useState(
    businessName ? `A note from ${businessName}` : "A note from us",
  );
  const send = c.send;
  const flag = send ? phaseFlag(send.phase) : null;
  const recipients = c.recipients ?? 0;
  const message = (j: Record<string, unknown>) =>
    typeof j.message === "string" ? j.message : "Done.";

  return (
    <article className="cu-campaign">
      <div className="cu-campaign-head">
        <span className="word boxed low">{c.label ?? "campaign"}</span>
        <span className="cu-campaign-title">{c.summary}</span>
        {flag && (
          <span className={flag.tone === "live" ? "flag live" : `flag ${flag.tone}`}>
            {flag.tone === "live" && <span className="live-dot" aria-hidden="true" />} {flag.word}
          </span>
        )}
        {c.draft === null && (
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() =>
              void act({ action: "draft_campaign", proposal_id: c.proposal_id }, (j) =>
                j.fresh
                  ? "Drafted in your voice, with the AI disclosure and the footer. Read it below — nothing has been sent."
                  : "This campaign already has its draft.",
              )
            }
          >
            Draft the email
          </button>
        )}
      </div>

      {send && <p className="cu-send-line">{sendSentence(send, recipients)}</p>}

      {c.draft && <pre className="cu-draft">{c.draft.body}</pre>}

      {c.gaps.length > 0 ? (
        <p className="cu-rec-note">
          Before it can send, it still needs: {c.gaps.join("; ")}.{" "}
          {c.ask.map((q) => (
            <Link
              key={q.question_id}
              href={`/intake?ask=${encodeURIComponent(q.question_id)}`}
              className="cu-ask"
            >
              {q.label}
            </Link>
          ))}
        </p>
      ) : (
        send?.phase !== "sent" && (
          <p className="cu-rec-note">
            Complete for where you are. Added at send time: {c.at_send.join(" and ")}, after consent
            is checked again for every recipient.
          </p>
        )
      )}

      {send?.phase === "awaiting_approval" && c.draft && c.gaps.length === 0 && (
        <div className="cu-send-approve">
          <p className="cu-rec-note">
            <span className="flag alarm">irreversible</span> Once it goes, a sent email can&rsquo;t
            be recalled. It goes only to the customers who explicitly agreed to hear from you, each
            checked again at the moment it&rsquo;s sent, and every email carries its own unsubscribe
            link.
          </p>
          {c.irreversible === false ? (
            <p className="cu-rec-note">
              This campaign was approved as something that could be undone. Decline it in the queue
              and propose it again, so it is labelled honestly before you approve it.
            </p>
          ) : confirming ? (
            <form
              className="cu-send-form"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirming(false);
                void act(
                  {
                    action: "approve_campaign_email",
                    proposal_id: c.proposal_id,
                    subject,
                    body_sha256: send.body_sha256,
                  },
                  message,
                );
              }}
            >
              <label className="cs-label" htmlFor={`cu-subj-${c.proposal_id}`}>
                Subject line
              </label>
              <input
                id={`cu-subj-${c.proposal_id}`}
                className="cu-input"
                maxLength={200}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <div className="cu-actions">
                <button
                  type="submit"
                  className="act solid"
                  disabled={busy || subject.trim() === ""}
                >
                  Approve and send to up to {num(recipients)} <span aria-hidden="true">→</span>
                </button>
                <button type="button" className="act" onClick={() => setConfirming(false)}>
                  Not yet
                </button>
              </div>
            </form>
          ) : (
            <div className="cu-actions">
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Approve this email…
              </button>
            </div>
          )}
        </div>
      )}

      {send && (send.phase === "held" || send.phase === "sending") && (
        <div className="cu-send-held">
          {send.gates.length > 1 && <p className="cs-label">Also waiting on</p>}
          {send.gates.length > 1 && (
            <ul className="cu-gates" aria-label="Also waiting on">
              {send.gates.slice(1).map((g) => (
                <li key={g.code}>{g.words}</li>
              ))}
            </ul>
          )}
          <div className="cu-actions">
            <button
              type="button"
              className="act"
              disabled={busy}
              onClick={() =>
                void act({ action: "send_campaign", proposal_id: c.proposal_id }, message)
              }
            >
              Try sending now
            </button>
          </div>
        </div>
      )}

      {send && send.counts.total > 0 && (
        <>
          <table className="rt cu-send-table">
            <tbody>
              {countRows(send.counts).map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="num">{num(r.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {refusalLines(send.counts).length > 0 && (
            <p className="cu-rec-note">Refused at send: {refusalLines(send.counts).join(" · ")}.</p>
          )}
          {unknownLine(send.counts) && <p className="cu-rec-note">{unknownLine(send.counts)}</p>}
        </>
      )}

      {c.readback && <Readback r={c.readback} />}
    </article>
  );
}

/** P4-17: what happened after it went out, as numbers, the verdict and what wasn't measured. */
function Readback({ r }: { r: ReadbackView }) {
  const flag = readbackFlag(r.verdict);
  return (
    <section className="cu-readback" aria-label="What happened after it went out">
      <div className="cu-readback-head">
        <span className="cs-label">What happened after it went out</span>
        <span className={`flag ${flag.tone}`}>{flag.word}</span>
      </div>
      <table className="rt cu-readback-table">
        <thead>
          <tr>
            <th scope="col"> </th>
            <th scope="col" className="num">
              count
            </th>
            <th scope="col" className="num">
              rate
            </th>
          </tr>
        </thead>
        <tbody>
          {readbackRows(r).map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td className="num">{row.count}</td>
              <td className="num">{row.rate}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cu-rec-note">{r.arithmetic}.</p>
      <p className="cu-send-line">{measuredSentence(r)}</p>
    </section>
  );
}
