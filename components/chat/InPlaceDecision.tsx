"use client";

// A request that became a proposal, answered where the reply stands
// (docs/DASHBOARD-OVERHAUL.md C10, D1; the owner, 2026-11-17: the yes may
// be an exchange with the assistant "as long as we keep it on approve").
// It reads the queue for that one proposal and shows Home's own decision
// card: two equal answers, a reason on decline, a signed-in person,
// through PUT /api/proposals like the queue itself. A proposal that is not
// waiting (held back by a limit, already answered) gets the plain line and
// the link to the queue instead of buttons.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRole } from "../auth/RoleContext";
import { DecisionCard } from "../home/DecisionCard";
import type { DecisionLike } from "../home/DecisionCard";
import { useNavRefresh, useReviewOpener } from "../nav/NavContext";
import "../../app/home.css";
import { effectRange, rangeWords } from "../proposals/queue-model";
import type { ScenarioOutcomeLike } from "../proposals/queue-model";
import { useTr } from "../sheet/useTr";
import { intlTag } from "../../lib/i18n/locales";

interface Pending extends DecisionLike {
  scenario?: {
    downside_case?: ScenarioOutcomeLike | null;
    upside_case?: ScenarioOutcomeLike | null;
  };
  expires_at?: string | null;
}

type Found = { state: "reading" } | { state: "waiting"; proposal: Pending } | { state: "other" };

export function InPlaceDecision({ id }: { id: string }) {
  const { tr, locale } = useTr("chat");
  const { tr: home } = useTr("home");
  const { access } = useRole();
  const refresh = useNavRefresh();
  // Inside the frame "Open" reads the whole decision in place, over this page
  // (the review's round 1: it went to the decision's own page from here).
  const openReview = useReviewOpener();
  const [found, setFound] = useState<Found>({ state: "reading" });
  // Raised when the decision was answered in that sheet: this card reads it again.
  const [read, setRead] = useState(0);

  useEffect(() => {
    let alive = true;
    setFound({ state: "reading" });
    fetch("/api/proposals", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { pending?: Pending[] }) : null))
      .then((queue) => {
        if (!alive) return;
        const proposal = queue?.pending?.find((p) => p.id === id);
        setFound(proposal ? { state: "waiting", proposal } : { state: "other" });
      })
      .catch(() => {
        if (alive) setFound({ state: "other" });
      });
    return () => {
      alive = false;
    };
  }, [id, read]);

  if (found.state === "reading") return null;
  if (found.state === "other") {
    return (
      <p className="ak-queued inset">
        {tr("queued.text")} <Link href="/proposals">{tr("queued.link")}</Link>
      </p>
    );
  }
  const p = found.proposal;
  const r = effectRange(p.scenario?.downside_case, p.scenario?.upside_case);
  const by = p.expires_at
    ? home("decisions.by", {
        date: new Date(p.expires_at).toLocaleDateString(
          locale === "en" ? "en-GB" : intlTag(locale),
          { day: "numeric", month: "short" },
        ),
      })
    : null;
  return (
    <div className="ak-decide">
      <p className="ak-queued inset">{tr("queued.text")}</p>
      <DecisionCard
        proposal={p}
        range={r ? rangeWords(r, locale) : null}
        by={by}
        signedIn={access ? access.signed_in === true : null}
        onDecided={refresh}
        {...(openReview
          ? { onReview: (which: string) => openReview(which, () => setRead((n) => n + 1)) }
          : {})}
      />
    </div>
  );
}
