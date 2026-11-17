"use client";

// One proposal's body and its answers, shared by the page a phone alert
// opens (ProposalCard.tsx) and by the review sheet that opens a decision in
// place (ReviewSheet.tsx, docs/DASHBOARD-OVERHAUL.md C5), so the two can
// never word or decide one proposal two ways.
//
// The body reads top to bottom as the queue's mobile card does (ux-spec
// §8): what changes, the gain as a range, the worst case, whether it can
// be undone, and what it was checked against (the owner's 13.5 answer).
// The answers are Approve and Decline, equal in weight, through the
// queue's own decision endpoint (PUT /api/proposals): the same checks, the
// same decision log, the yes recorded with the signed-in person's name
// (rule 12). A decline takes a reason. An answered, expired or held-back
// proposal says so, with no buttons.

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTr } from "../sheet/useTr";
import type { CardLimit, CardProposal } from "./card-model";
import { cardState, gainLine, limitLines, readsAsWords, undoLine, worstCase } from "./card-model";
import type { ReasonChip } from "./queue-model";
import {
  REASON_CHIPS,
  activeChip,
  applyReasonChip,
  chipLabel,
  approvalNote,
  changeLines,
  consequence,
  effectSpan,
  shortRef,
} from "./queue-model";
import "../../app/queue.css";

/** What GET /api/proposals/<id> returns for the card. */
export interface CardData {
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

export type Answer = "approve" | "reject";

/** The proposal's sections. `titleId` draws its own head (the page); without it the host names it (the sheet). */
export function ProposalSections({ data, titleId }: { data: CardData; titleId?: string }) {
  const t = useTranslations("proposals");
  const { tr, locale } = useTr("proposals");
  const qw = useTr("queueWords");
  const p = data.proposal;
  const gain = gainLine(p, locale);
  const undo = undoLine(p, tr);
  const lines = changeLines(p.action, undefined, qw);
  return (
    <>
      {titleId && (
        <header className="q-mcard-head">
          <p className="q-ref">
            {shortRef(p.id)} · {t("module", { module: p.module })}
          </p>
          <h1 id={titleId} className="q-title">
            {p.action.summary}
          </h1>
        </header>
      )}

      {/* With no before and after stated, the title is the change (ux-spec §8.3): nothing is printed. */}
      {lines && (
        <section className="q-msec">
          <h2 className="q-mlabel">{t("m.changes")}</h2>
          <dl className="q-mlines">
            {lines.map((l) =>
              // A page's wording does not fit a right-aligned figure line: it
              // stacks, each side named, as on the queue's own card.
              readsAsWords(l) ? (
                <div key={l.line} className="q-mline q-mline-words">
                  <dt>
                    {l.line}
                    {l.sub && <span className="q-line-sub">{l.sub}</span>}
                  </dt>
                  <dd>
                    <span className="q-mline-side">{t("change.before")}</span>
                    <span className="q-before">{l.before}</span>
                  </dd>
                  <dd>
                    <span className="q-mline-side">{t("change.after")}</span>
                    <span className="q-after">{l.after}</span>
                  </dd>
                </div>
              ) : (
                <div key={l.line} className="q-mline">
                  <dt>{l.line}</dt>
                  <dd className="fig">
                    {l.before} <span aria-hidden="true">→</span>
                    <span className="sr-only"> {t("change.becomes")} </span> {l.after}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>
      )}

      <section className="q-msec">
        <h2 className="q-mlabel">{t("m.expectedSpan", { span: effectSpan(p.action, qw) })}</h2>
        {gain ? (
          <p className="q-fig fig">{gain}</p>
        ) : (
          <p className="q-effect-words">{t("card.noRange")}</p>
        )}
        <p className="q-mono-note">{t("card.worst", { worst: worstCase(p, { tr, locale }) })}</p>
      </section>

      <section className="q-msec">
        <div className="q-rev-row">
          <span className={`word boxed q-revword${undo.reversible ? "" : " q-irrev"}`}>
            {undo.reversible ? t("rev.reversibleWord") : t("rev.irreversible")}
          </span>
          <span className="q-rev-note">{undo.note || undo.word}</span>
        </div>
      </section>

      <section className="q-msec">
        <h2 className="q-mlabel">{t("card.limits")}</h2>
        {limitLines(data.limits, tr).map((l) => (
          <p key={l} className="q-prose">
            {l}
          </p>
        ))}
      </section>
    </>
  );
}

/**
 * The answers: Approve (the consequence verb) and Decline as equal buttons,
 * the reason on decline; or the sentence saying why there are none.
 */
export function ProposalAnswers({
  data,
  where,
  halted = false,
  returnTo,
  onAnswered,
  onSignedOut,
}: {
  data: CardData;
  /** The page keeps its arrows and its way back to the queue; the sheet has its own close. */
  where: "page" | "sheet";
  /** Everything is stopped: the note under the answers says so. */
  halted?: boolean;
  /** Where sign-in comes back to. */
  returnTo: string;
  onAnswered: (answer: Answer) => void;
  /** The sign-in ended between reading and answering. */
  onSignedOut: () => void;
}) {
  const t = useTranslations("proposals");
  const { tr, locale } = useTr("proposals");
  const qw = useTr("queueWords");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const p = data.proposal;
  const st = cardState(p, new Date(), undefined, { tr, locale });
  const chip = activeChip(reason, tr);
  const signIn = `/login?next=${encodeURIComponent(returnTo)}`;
  const arrow = where === "page" ? <span aria-hidden="true">→</span> : null;
  const publishAt =
    typeof p.action.detail?.publish_at === "string" ? p.action.detail.publish_at : null;
  const runAt =
    publishAt ?? (p.action.detail?.execute_on_approval === true ? new Date().toISOString() : null);

  const decide = async (decision: Answer) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/proposals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [p.id],
          decision,
          ...(decision === "reject" ? { reason: reason.trim() } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        decided?: string[];
        failed?: { error: string }[];
        error?: string;
      };
      if (res.status === 401) return onSignedOut();
      if (!j.decided?.includes(p.id)) {
        setNotice(
          t("card.notRecorded", { error: j.failed?.[0]?.error ?? j.error ?? t("card.wrong") }),
        );
        return;
      }
      setDeclining(false);
      onAnswered(decision);
    } catch {
      setNotice(t("card.notRecorded", { error: t("card.wrong") }));
    } finally {
      setBusy(false);
    }
  };

  if (st.kind === "closed") {
    return (
      <section className="q-mdecide" aria-label={t("card.answered")}>
        <p className="q-rev-row">
          <span className="word boxed">{st.word}</span>
          <span className="q-rev-note" role="status">
            {st.sentence}
          </span>
        </p>
        {where === "page" && (
          <Link className="q-btn" href="/proposals">
            {t("card.back")} {arrow}
          </Link>
        )}
      </section>
    );
  }
  if (!data.signed_in) {
    return (
      <section className="q-mdecide" aria-label={t("decide.label")}>
        <p className="q-approve-note">{t("card.needSignIn")}</p>
        <Link className="q-btn" href={signIn}>
          {t("card.signInToDecide")} {arrow}
        </Link>
      </section>
    );
  }
  return (
    <section className="q-mdecide" aria-label={t("decide.label")}>
      {notice && (
        <p className="q-need" role="alert">
          {notice}
        </p>
      )}
      <div className="q-mpair">
        <button
          type="button"
          className="q-btn"
          disabled={busy || Boolean(data.decide_why)}
          onClick={() => void decide("approve")}
        >
          {consequence(p.action, tr, locale)} {arrow}
        </button>
        <button
          type="button"
          className="q-btn"
          disabled={busy || Boolean(data.decide_why)}
          aria-expanded={declining}
          onClick={() => setDeclining((d) => !d)}
        >
          {t("decide.decline")} {arrow}
        </button>
      </div>
      {declining && (
        <div className="q-panel">
          <p className="q-panel-label" id={`why-${p.id}`}>
            {t("reason.why")}
          </p>
          <div className="q-chips" role="group" aria-labelledby={`why-${p.id}`}>
            {REASON_CHIPS.map((c: ReasonChip) => (
              <button
                key={c}
                type="button"
                className="q-chip"
                aria-pressed={chip === c}
                onClick={() => setReason(applyReasonChip(reason, c, tr))}
              >
                {chipLabel(c, tr)}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor={`reason-${p.id}`}>
            {t("reason.label")}
          </label>
          <textarea
            id={`reason-${p.id}`}
            className="q-text"
            placeholder={t("reason.placeholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="q-panel-foot">{t("card.declineFoot")}</p>
          <button
            type="button"
            className="q-btn q-btn-inline"
            disabled={busy || Boolean(data.decide_why) || reason.trim() === ""}
            onClick={() => void decide("reject")}
          >
            {t("reason.record")} {arrow}
          </button>
        </div>
      )}
      <p className="q-approve-note">
        {approvalNote({ runAt, sending: p.action.detail?.sending, tr, locale, qw })}
        {halted && ` ${t("decide.halted")}`}
      </p>
      {data.decide_why && (
        <p className="q-role-note" role="note">
          {data.decide_why}
        </p>
      )}
      <Link className="q-quiet" href="/proposals">
        {t("card.wholeQueue")}
      </Link>
    </section>
  );
}
