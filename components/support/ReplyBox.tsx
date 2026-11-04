"use client";

// The reply box on a ticket — Phase 4 Session C (P4-10). The owner asks
// for a draft (their click; nothing drafts by itself), edits it or writes
// their own, and approves the exact words on screen. Approve and Decline
// carry equal weight and sit apart. Every state is a word: drafted,
// approved but not sent (and why), sending with an unknown outcome, sent.
// An AI draft shows the disclosure line that will be added when it is
// sent — added in code, so it is not in the box to edit.
//
// L-3c: the box's own words are the "support" catalogue in the owner's
// language. The disclosure line itself is customer-facing — it goes out in
// the email — so it stays as lib/support-desk/disclosure writes it (the
// business's language, L-5/L-6); the reply and a send's outcome note are
// content and the server's words.

import { useEffect, useRef, useState } from "react";
import { replyDisclosure } from "../../lib/support-desk/disclosure";
import type { Tr } from "../../lib/i18n/tr";
import { useTr } from "../sheet/useTr";
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
  const { tr } = useTr("support");
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
          <span className="word alarm">{tr("reply.noWay")}</span>
        </p>
        <p className="sp-fine">{tr("reply.noAddress")}</p>
      </div>
    );
  }

  const state = live ? replyStateWord(live.status, tr) : null;

  return (
    <div className="sp-box sp-reply">
      <p className="sp-box-label">
        <span className="cs-label">{tr("reply.label")}</span>
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
                  ? tr("notice.drafted")
                  : String(j.message ?? tr("notice.noDraft")),
              )
            }
          >
            {tr("reply.draft")}
          </button>
          <button type="button" className="act" disabled={busy} onClick={() => setWriting(true)}>
            {tr("reply.writeMyself")}
          </button>
          <span className="sp-fine">{tr("reply.draftUses")}</span>
        </div>
      )}

      {(live?.status === "drafted" || (!live && writing)) && (
        <>
          <label className="cs-label" htmlFor={`sp-r-${key}`}>
            {live?.ai_drafted ? tr("reply.aiLabel") : tr("reply.yourReply")}
          </label>
          <textarea
            id={`sp-r-${key}`}
            className="sp-textarea"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <MicButton
            label={tr("reply.speak")}
            getText={() => textRef.current}
            setText={setText}
            after={tr("reply.speakAfter")}
            disabled={busy}
          />
          {live?.ai_drafted && (
            <p className="sp-fine sp-disclosure">
              {tr("reply.disclosure", { line: replyDisclosure(businessName) })}
            </p>
          )}
          <div className="sp-row sp-apart">
            <button
              type="button"
              className="act"
              disabled={busy || text.trim() === ""}
              onClick={async () => {
                if (live) {
                  await act({ action: "approve_reply", reply_id: live.id, body: text }, (j) =>
                    sentNotice(j, tr),
                  );
                  return;
                }
                await act({ action: "save_reply", ticket_id: ticketId, body: text }, () =>
                  tr("notice.savedReply"),
                );
                setWriting(false);
              }}
            >
              {live ? tr("reply.approveSend") : tr("reply.save")}
            </button>
            {live ? (
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() =>
                  void act({ action: "decline_reply", reply_id: live.id }, tr("notice.declined"))
                }
              >
                {tr("reply.decline")}
              </button>
            ) : (
              <button
                type="button"
                className="act"
                disabled={busy}
                onClick={() => setWriting(false)}
              >
                {tr("reply.cancel")}
              </button>
            )}
          </div>
          <p className="sp-fine">{tr("reply.untilApprove")}</p>
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
                onClick={() =>
                  void act({ action: "send_reply", reply_id: live.id }, (j) => sentNotice(j, tr))
                }
              >
                {tr("reply.sendNow")}
              </button>
              <span className="sp-fine">{tr("reply.approvedExact")}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The notice after an approval or a send; a held send's reason is the server's note, in the reader's language (L-4c). */
function sentNotice(j: Record<string, unknown>, tr: Tr): string {
  if (j.status === "sent") return tr("notice.sent");
  return String(j.note ?? tr("notice.approvedNotSent"));
}
