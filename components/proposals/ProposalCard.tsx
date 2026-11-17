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
//
// The sections and the answers themselves live in ProposalBody.tsx, shared
// with the review sheet that opens a decision in place (2026-11-17).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { EmergencyStop } from "../execution/EmergencyStop";
import type { CardData } from "./ProposalBody";
import { ProposalAnswers, ProposalSections } from "./ProposalBody";
import "../../app/queue.css";
import { Logo } from "../brand/Mark";

type Phase =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "missing" }
  | { phase: "error" }
  | { phase: "ready"; data: CardData };

export function ProposalCard({ id }: { id: string }) {
  const t = useTranslations("proposals");
  const [state, setState] = useState<Phase>({ phase: "loading" });
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
  const returnTo = `/proposals/${id}`;
  const signIn = `/login?next=${encodeURIComponent(returnTo)}`;

  const masthead = (business: string | null) => (
    <header className="q-mast q-mast-m">
      <div className="q-mast-row">
        <Link href="/watch" className="q-wordmark">
          <Logo onDark />
        </Link>
        <span className="q-mast-meta">
          {business ? `${business} · ` : ""}
          {t("card.decision")}
        </span>
      </div>
      <div className="q-mast-row">
        <EmergencyStop variant="masthead" onState={onHaltState} />
      </div>
    </header>
  );

  if (state.phase === "loading") {
    return (
      <div className="q-app q-m">
        <p className="q-loading">{t("card.loading")}</p>
      </div>
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
            <span className="auth-eyebrow">{t("card.eyebrow")}</span>
            <h1 className="auth-title">{t("signedOut.title")}</h1>
            <p className="auth-copy">{t("card.signedOut")}</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href={signIn}>
              {t("signedOut.signIn")}
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
              {state.phase === "missing" ? t("card.missing") : t("card.failed")}
            </h1>
            <p className="q-prose">
              {state.phase === "missing" ? t("card.missingLede") : t("card.failedLede")}{" "}
              <Link href="/proposals">{t("card.openQueue")}</Link>
            </p>
          </section>
        </main>
      </div>
    );
  }

  const { data } = state;
  const titleId = `card-${data.proposal.id}`;

  return (
    <div className="q-app q-m">
      {masthead(data.business)}
      <main className="q-m-main">
        <article className="q-sheet q-mcard" aria-labelledby={titleId}>
          <ProposalSections data={data} titleId={titleId} />
          <ProposalAnswers
            data={data}
            where="page"
            halted={halted}
            returnTo={returnTo}
            // The card reads itself again and shows its closed state, announced politely.
            onAnswered={() => void load()}
            onSignedOut={() => setState({ phase: "signedout" })}
          />
        </article>
      </main>
    </div>
  );
}
