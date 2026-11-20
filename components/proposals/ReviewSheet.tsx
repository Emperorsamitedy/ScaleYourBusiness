"use client";

// A decision opened in place (docs/DASHBOARD-OVERHAUL.md C5): the side
// sheet that reads one proposal without leaving the page. What changes,
// what is expected and the worst case, whether it can be undone, what it
// was checked against; then Approve and Decline, equal, in the sheet's
// foot. The same body and the same answers as the page a phone alert opens
// (ProposalBody.tsx), through the queue's own endpoint. An answered one is
// read-only. The host keeps the open id (Home keeps it in the address,
// `?review=`), so Back closes the sheet and a link opens it.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAppLocale } from "../sheet/useTr";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import type { Answer, CardData } from "./ProposalBody";
import { ProposalAnswers, ProposalSections } from "./ProposalBody";
import { dayWord } from "./queue-model";
import "../../app/queue.css";

type Phase =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "missing" }
  | { phase: "error" }
  | { phase: "ready"; data: CardData };

/** What the host's own list already holds about the proposal: the sheet's head, at once. */
export interface KnownProposal {
  id: string;
  summary: string;
  module?: string | null | undefined;
  status?: string | null | undefined;
  expires_at?: string | null | undefined;
}

export function ReviewSheet({
  id,
  known = null,
  halted = false,
  returnTo,
  onClose,
  onAnswered,
}: {
  /** The proposal to read; null closes the sheet. */
  id: string | null;
  /** The row it was opened from: its title shows while the whole of it is read. */
  known?: KnownProposal | null;
  halted?: boolean;
  /** Where sign-in comes back to: the page with this sheet open. */
  returnTo: string;
  onClose: () => void;
  /** After a recorded answer; the host says so, closes and reads its lists again. */
  onAnswered: (id: string, answer: Answer) => void;
}) {
  const t = useTranslations("proposals");
  // The deadline as Home's own card words it: a label, where the queue's is a sentence.
  const h = useTranslations("home");
  const locale = useAppLocale();
  const [state, setState] = useState<Phase>({ phase: "loading" });

  const load = useCallback(async (which: string) => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/proposals/${which}`, { cache: "no-store" });
      if (res.status === 401) return setState({ phase: "signedout" });
      if (res.status === 404) return setState({ phase: "missing" });
      if (!res.ok) return setState({ phase: "error" });
      setState({ phase: "ready", data: (await res.json()) as CardData });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  if (!id) return null;
  const data = state.phase === "ready" && state.data.proposal.id === id ? state.data : null;
  const reading = state.phase === "loading" || state.phase === "ready";
  // The head: the proposal as read, or, while it is being read, the row it was opened from.
  const head: KnownProposal | null = data
    ? {
        id,
        summary: data.proposal.action.summary,
        module: data.proposal.module,
        status: data.proposal.status,
        expires_at: data.proposal.expires_at,
      }
    : reading && known?.id === id
      ? known
      : null;
  const title = head
    ? head.summary
    : state.phase === "missing"
      ? t("card.missing")
      : state.phase === "error"
        ? t("card.failed")
        : state.phase === "signedout"
          ? t("signedOut.title")
          : t("card.loading");
  const by =
    head?.status === "pending" && head.expires_at
      ? h("decisions.by", { date: dayWord(head.expires_at, undefined, locale) })
      : null;
  const kicker = head
    ? [head.module ? t("module", { module: head.module }) : null, by].filter(Boolean).join(" · ") ||
      t("card.eyebrow")
    : t("card.eyebrow");

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      kicker={kicker}
      width={560}
      foot={
        data ? (
          <ProposalAnswers
            data={data}
            where="sheet"
            halted={halted}
            returnTo={returnTo}
            onAnswered={(answer) => onAnswered(id, answer)}
            onSignedOut={() => setState({ phase: "signedout" })}
          />
        ) : undefined
      }
    >
      <div className="q-review" aria-busy={state.phase === "loading"}>
        {data ? (
          <ProposalSections data={data} />
        ) : reading ? (
          <Skeleton lines={7} className="q-review-skel" />
        ) : (
          <>
            <p className="q-prose">
              {state.phase === "missing"
                ? t("card.missingLede")
                : state.phase === "signedout"
                  ? t("card.needSignIn")
                  : t("card.failedLede")}
            </p>
            {state.phase === "error" && (
              <button type="button" className="q-btn q-btn-inline" onClick={() => void load(id)}>
                {t("review.retry")}
              </button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
