"use client";

// The needs-you badge — P3-07, ux-spec §3/§9. Exactly one badge exists
// in the product and it counts approvals, because an approval is the
// only thing that is ever the owner's turn. In-app only: the
// one-push-per-day rule is recorded in TASKS-PHASE3.md for when push
// notifications arrive; nothing here sends anything.
//
// Signed out (or no profile) the component renders nothing — a badge
// that begs you to sign in is a notification, not a count.

import { useEffect, useState } from "react";
import Link from "next/link";

export function ProposalsBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/proposals")
      .then(async (res) => {
        if (!res.ok) return;
        const j = (await res.json()) as { pending_count?: number };
        if (alive && typeof j.pending_count === "number") setCount(j.pending_count);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (count === null) return null;
  return (
    <Link href="/proposals" className="prop-badge-link">
      Proposals
      {count > 0 && <span className="prop-badge">{count}</span>}
    </Link>
  );
}
