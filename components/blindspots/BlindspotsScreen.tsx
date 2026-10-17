"use client";

// Customer blindspots — Phase 2 Session G (P2-32..37). What potential
// customers search for, ask about and check before buying, against what
// the business actually shows them. Every line names its counts and its
// sources; what isn't connected is said, not hidden. Read-only.

import { useEffect, useState } from "react";
import Link from "next/link";

interface Demand {
  support_asked: number;
  support_unanswered: number;
  site_searches: number;
  google_impressions: number;
  google_clicks: number;
}
interface View {
  window: { from: string; to: string };
  site_checked_at: string | null;
  site_note: string | null;
  blindspots: {
    code: string;
    label: string;
    sources: number;
    arithmetic: string;
    fix: string;
    demand: Demand;
  }[];
  hard_to_find: { code: string; label: string; page: string; asked: number }[];
  seen_not_chosen: { query: string; impressions: number; clicks: number; position: number }[];
  topics: { label: string; count: number; examples: string[] }[];
  coverage: string[];
}

export function BlindspotsScreen() {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/blindspots");
        if (res.status === 401) return setFailed("signed_out");
        if (!res.ok) return setFailed("error");
        setView((await res.json()) as View);
      } catch {
        setFailed("error");
      }
    })();
  }, []);

  if (failed) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">
          {failed === "signed_out" ? (
            <>
              There&apos;s no business here yet.{" "}
              <Link href="/intake">Start with the interview</Link>.
            </>
          ) : (
            "Something went wrong looking for blindspots. Refresh to try again."
          )}
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading what customers look for…</p>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          blindspots · {view.window.from} to {view.window.to}
          {view.site_checked_at ? ` · site read ${view.site_checked_at.slice(0, 10)}` : ""}
        </span>
      </header>

      <section className="card ops-card">
        <span className="auth-eyebrow">
          what customers look for that your site doesn&apos;t show
        </span>
        {view.blindspots.length === 0 ? (
          <p className="auth-copy">
            {view.site_checked_at
              ? "Nothing yet — everything customers asked or searched for that we can match is on your site."
              : (view.site_note ?? "Your website hasn't been read yet.")}
          </p>
        ) : (
          <ul className="mode-reasons">
            {view.blindspots.map((b) => (
              <li key={b.code}>
                <strong>{b.label}</strong> — {b.arithmetic}.{" "}
                <span className="conn-note" style={{ display: "inline" }}>
                  To fix: {b.fix}.
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.hard_to_find.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">
            on your site, yet customers keep asking — maybe hard to find
          </span>
          <ul className="mode-reasons">
            {view.hard_to_find.map((h) => (
              <li key={h.code}>
                <strong>{h.label}</strong> — asked {h.asked} times in your support chat; it&apos;s
                on{" "}
                <a href={h.page} target="_blank" rel="noreferrer">
                  {h.page}
                </a>
                .
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.seen_not_chosen.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">seen on Google, rarely clicked</span>
          <ul className="mode-reasons">
            {view.seen_not_chosen.map((q) => (
              <li key={q.query}>
                &ldquo;{q.query}&rdquo; — shown {q.impressions} times at position {q.position},
                clicked {q.clicks}. The title and description people see may not match what they
                want.
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.topics.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">other things people search for</span>
          <ul className="mode-reasons">
            {view.topics.map((t) => (
              <li key={t.label}>
                <strong>{t.label}</strong> — {t.count} searches (e.g.{" "}
                {t.examples.map((e) => `"${e}"`).join(", ")}). Is it on your site?
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.coverage.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">what this couldn&apos;t see</span>
          <ul className="mode-reasons">
            {view.coverage.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="conn-note">
            Connect more on <Link href="/connections">Connections</Link>.
          </p>
        </section>
      )}
    </main>
  );
}
