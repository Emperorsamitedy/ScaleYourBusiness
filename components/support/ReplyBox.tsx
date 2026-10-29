"use client";

// The reply box on a ticket — Phase 4 Session C (P4-10). The owner asks
// for a draft (their click; nothing drafts by itself), edits it or writes
// their own, and approves the exact words on screen. Approve and Decline
// carry equal weight and sit apart. Every state is a word: drafted,
// approved but not sent (and why), sending with an unknown outcome, sent.
// An AI draft shows the disclosure line that will be added when it is
// sent — added in code, so it is not in the box to edit.

import { useEffect, useRef, useState } from "react";
import { replyDisclosure } from "../../lib/support-desk/disclosure";
import { MicButton } from "../voice/MicButton";
import { replyStateWord } from "./support-view";

export interface Reply {
  id: string;
  status: "drafted" | "declined" | "approved" | "sending" | "sent" | "failed";
  ai_drafted: boolean;
  body: string;
  sent_text: string | null;
  approved_at: string | null;
  sent_at: string | null;
  outcome_note: string | null;
  created_at: string;
}

type Act = (
  payload: Record<string, unknown>,
  notice: string | ((json: Record<string, unknown>) => string),
) => Promise<void>;

export function ReplyBox({
  ticketId,
  replies,
  reachable,
  businessName,
  busy,
  act,
}: {
  ticketId: string;
  replies: Reply[];
  /** False: no address on this ticket — nobody can be replied to. */
  reachable: boolean;
  businessName: string;
  busy: boolean;
  act: Act;
}) {
  const live = replies.find((r) => ["drafted", "approved", "sending"].includes(r.status)) ?? null;
  const lastFailed = [...replies].reverse().find((r) => r.status === "failed") ?? null;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState(false);
  const key = live?.id ?? `new:${ticketId}`;
  const text = texts[key] ?? live?.body ?? (writing ? (lastFailed?.body ?? "") : "");
  // Kept in step on every write, so the microphone (idea 50) can tell the
  // owner's typing from its own words; the effect catches a draft arriving.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const setText = (v: string) => {
    textRef.current = v;
    setTexts((cur) => ({ ...cur, [key]: v }));
  };

  if (!reachable) {
    return (
      <div className="sp-box sp-reply">
        <p className="sp-box-label">
          <span className="word alarm">no way to reach them</span>
        </p>
        <p className="sp-fine">
          This customer left no email address, so there is no way to reply. They see an answer only
          if they come back to the chat.
        </p>
      </div>
    );
  }

  const state = live ? replyStateWord(live.status) : null;

  return (
    <div className="sp-box sp-reply">
      <p className="sp-box-label">
        <span className="cs-label">Reply by email</span>
        {state && <span className={`word ${state.tone}`}>{state.word}</span>}
      </p>

      {lastFailed && !live && <p className="sp-fine sp-note">{lastFailed.outcome_note}</p>}

      {!live && !writing && (
        <div className="sp-row">
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() =>
              void act({ action: "draft_reply", ticket_id: ticketId }, (j) =>
                j.drafted === true
                  ? "Drafted from your approved answers. Read it, edit it, then approve or decline."
                  : String(j.message ?? "No draft."),
              )
            }
          >
            Draft a reply
          </button>
          <button type="button" className="act" disabled={busy} onClick={() => setWriting(true)}>
            Write it myself
          </button>
          <span className="sp-fine">A draft uses only your approved answers.</span>
        </div>
      )}

      {(live?.status === "drafted" || (!live && writing)) && (
        <>
          <label className="cs-label" htmlFor={`sp-r-${key}`}>
            {live?.ai_drafted ? "The assistant's draft — edit it freely" : "Your reply"}
          </label>
          <textarea
            id={`sp-r-${key}`}
            className="sp-textarea"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <MicButton
            label="Speak your reply"
            getText={() => textRef.current}
            setText={setText}
            after="Read it over and fix anything before you save or approve it."
            disabled={busy}
          />
          {live?.ai_drafted && (
            <p className="sp-fine sp-disclosure">
              Added when it is sent, and not removable: &ldquo;{replyDisclosure(businessName)}
              &rdquo;
            </p>
          )}
          <div className="sp-row sp-apart">
            <button
              type="button"
              className="act"
              disabled={busy || text.trim() === ""}
              onClick={async () => {
                if (live) {
                  await act({ action: "approve_reply", reply_id: live.id, body: text }, sentNotice);
                  return;
                }
                await act(
                  { action: "save_reply", ticket_id: ticketId, body: text },
                  () => "Saved. Approve and send it when it's right.",
                );
                setWriting(false);
              }}
            >
              {live ? "Approve and send" : "Save my reply"}
            </button>
            {live ? (
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() =>
                  void act(
                    { action: "decline_reply", reply_id: live.id },
                    "Declined. Nothing was sent.",
                  )
                }
              >
                Decline draft
              </button>
            ) : (
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() => setWriting(false)}
              >
                Cancel
              </button>
            )}
          </div>
          <p className="sp-fine">Nothing goes to the customer until you approve it.</p>
        </>
      )}

      {live && live.status !== "drafted" && (
        <>
          <pre className="sp-sent">{live.sent_text}</pre>
          {live.outcome_note && <p className="sp-fine sp-note">{live.outcome_note}</p>}
          {live.status === "approved" && (
            <div className="sp-row">
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() => void act({ action: "send_reply", reply_id: live.id }, sentNotice)}
              >
                Send it now
              </button>
              <span className="sp-fine">Approved; it goes exactly as written above.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function sentNotice(j: Record<string, unknown>): string {
  if (j.status === "sent") return "Sent, exactly as you approved it.";
  return String(j.note ?? "Approved, not sent.");
}
