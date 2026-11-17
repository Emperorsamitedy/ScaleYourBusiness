"use client";

// One waiting decision, decided where it is shown: on Home's "Needs your
// yes", and under the reply that drafted it (the owner, 2026-11-17: the
// yes may be an exchange with the assistant, as long as it stays an
// approval). The two answers are equal (ux-spec §8), a decline takes a
// reason, and both go through PUT /api/proposals, the queue's own path:
// the same checks, the same decision log, the yes recorded with the
// signed-in person's name (rule 12). Nothing here runs anything.

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReasonChip } from "../proposals/queue-model";
import {
  REASON_CHIPS,
  activeChip,
  applyReasonChip,
  chipLabel,
  consequence,
} from "../proposals/queue-model";
import { useTr } from "../sheet/useTr";

export interface DecisionLike {
  id: string;
  action: { kind?: string; summary: string; detail?: unknown };
}

export type Answer = "approve" | "reject";

export function DecisionCard({
  proposal,
  range,
  by,
  signedIn,
  onDecided,
}: {
  proposal: DecisionLike;
  /** The money range, already in words, or null when the proposal states none. */
  range: string | null;
  /** "decide by 12 Nov", or null. */
  by: string | null;
  /** Deciding is recorded with a name, so it needs a signed-in person. */
  signedIn: boolean;
  /** After a recorded answer; the caller re-reads the queue. */
  onDecided: (id: string, answer: Answer) => void;
}) {
  const t = useTranslations("proposals");
  const { tr, locale } = useTr("proposals");
  const { tr: h } = useTr("home");
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Answer | null>(null);
  const chip = activeChip(reason, tr);
  const p = proposal;

  const decide = async (answer: Answer) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/proposals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [p.id],
          decision: answer,
          ...(answer === "reject" ? { reason: reason.trim() } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        decided?: string[];
        failed?: { error: string }[];
        error?: string;
      };
      if (!j.decided?.includes(p.id)) {
        setNotice(
          t("card.notRecorded", { error: j.failed?.[0]?.error ?? j.error ?? t("card.wrong") }),
        );
        return;
      }
      setRecorded(answer);
      setDeclining(false);
      onDecided(p.id, answer);
    } catch {
      setNotice(t("card.notRecorded", { error: t("card.wrong") }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="hd" aria-label={t("decide.label")}>
      {by && <p className="hd-lab">{by}</p>}
      <p className="hd-title">{p.action.summary}</p>
      {range && <p className="hd-amt fig">{range}</p>}
      {recorded ? (
        <p className="hd-done" role="status">
          <span className={`flag ${recorded === "approve" ? "ok" : "low"}`}>
            {recorded === "approve" ? h("done.approved") : h("done.declined")}
          </span>{" "}
          {h("decide.recorded")}
        </p>
      ) : !signedIn ? (
        <p className="hd-note">
          {t("card.needSignIn")}{" "}
          <Link href={`/login?next=${encodeURIComponent("/home")}`}>
            {t("card.signInToDecide")}
          </Link>
        </p>
      ) : (
        <>
          <div className="hd-pair">
            <button
              type="button"
              className="hd-btn"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {consequence(p.action, tr, locale)}
            </button>
            <button
              type="button"
              className="hd-btn"
              disabled={busy}
              aria-expanded={declining}
              onClick={() => setDeclining((d) => !d)}
            >
              {t("decide.decline")}
            </button>
          </div>
          {declining && (
            <div className="hd-panel">
              <p className="hd-panel-lab" id={`why-${p.id}`}>
                {t("reason.why")}
              </p>
              <div className="hd-chips" role="group" aria-labelledby={`why-${p.id}`}>
                {REASON_CHIPS.map((c: ReasonChip) => (
                  <button
                    key={c}
                    type="button"
                    className="hd-chip"
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
                className="hd-text"
                placeholder={t("reason.placeholder")}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="hd-panel-foot">{t("card.declineFoot")}</p>
              <button
                type="button"
                className="hd-btn hd-btn-inline"
                disabled={busy || reason.trim() === ""}
                onClick={() => void decide("reject")}
              >
                {t("reason.record")}
              </button>
            </div>
          )}
        </>
      )}
      {notice && (
        <p className="hd-notice" role="alert">
          {notice}
        </p>
      )}
      <Link className="hd-more" href={`/proposals/${p.id}`}>
        {h("decide.details")}
      </Link>
    </article>
  );
}
