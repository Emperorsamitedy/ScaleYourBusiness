"use client";

// The Trust Ladder screen (the v1 spec §4.6). Reads /api/ladder; every
// change is a POST the server checks against the ledger's evidence, so
// nothing here decides anything — a raise the evidence doesn't support is
// refused there, whatever this page shows.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTr } from "../sheet/useTr";
import type { LadderOverview, LadderRow } from "../../lib/ladder/overview";

/** Rules that read differently met or unmet carry the state in their key. */
const SPLIT_RULES = new Set(["connector_healthy", "net_positive", "no_big_loss", "caps_set"]);
function ruleKey(rule: string, met: boolean): string {
  return SPLIT_RULES.has(rule) ? `rule.${rule}.${met ? "met" : "unmet"}` : `rule.${rule}`;
}

export function LadderScreen() {
  const { tr } = useTr("ladder");
  const [view, setView] = useState<LadderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/ladder");
    if (res.ok) setView((await res.json()) as LadderOverview);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/ladder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
    } & Partial<LadderOverview>;
    if (!res.ok) {
      setError(tr("failed", { why: json.error ?? "" }));
      return;
    }
    if (json.rows) setView(json as LadderOverview);
    else await load();
  }

  if (view === null) return <main className="auth-stage" aria-busy="true" />;

  return (
    <main className="auth-stage">
      <section className="card">
        <span className="auth-eyebrow">{tr("title")}</span>
        <p className="auth-copy">{tr("intro")}</p>
        {view.notices.map((n) => {
          const p = (n.payload ?? {}) as { capability?: string; provider?: string };
          return (
            <p key={n.id} className="auth-copy" role="status">
              {n.kind === "auto_demotion"
                ? tr("notice.auto_demotion", { capability: p.capability ?? "" })
                : tr("notice.connector_demotion", { provider: p.provider ?? "" })}{" "}
              <button type="button" onClick={() => void change({ op: "seen", notice_id: n.id })}>
                {tr("notice.seen")}
              </button>
            </p>
          );
        })}
        {error && (
          <p className="auth-copy" role="alert">
            {error}
          </p>
        )}
        <ul className="ladder-rows">
          {view.rows.map((r) => (
            <Row key={r.capability} row={r} tr={tr} change={change} />
          ))}
        </ul>
        <Link href="/shadow" className="auth-copy">
          {tr("shadowLink")}
        </Link>
      </section>
    </main>
  );
}

function Row({
  row,
  tr,
  change,
}: {
  row: LadderRow;
  tr: (k: string, v?: Record<string, string | number>) => string;
  change: (b: Record<string, unknown>) => Promise<void>;
}) {
  const unmet =
    row.next?.checks.filter((c) => !c.met).map((c) => tr(ruleKey(c.rule, c.met), c.params ?? {})) ??
    [];
  return (
    <li className="ladder-row">
      <b>{tr(`capability.${row.capability}`)}</b> — {tr(`station.${row.station}`)}
      <p className="auth-copy">
        {tr("record", {
          closed: row.record.closed,
          gains: row.record.gains,
          losses: row.record.losses,
        })}
      </p>
      {row.station > 1 && (
        <button
          type="button"
          onClick={() =>
            void change({ op: "station", capability: row.capability, to: row.station - 1 })
          }
        >
          {tr("lower")}
        </button>
      )}
      {row.next === null ? (
        <p className="auth-copy">{tr("ceiling", { station: row.ceiling })}</p>
      ) : unmet.length > 0 ? (
        <p className="auth-copy">{tr("notYet", { why: unmet.join("; ") })}</p>
      ) : row.station < 3 ? (
        <button
          type="button"
          onClick={() =>
            void change({ op: "station", capability: row.capability, to: row.station + 1 })
          }
        >
          {tr("raise")}
        </button>
      ) : row.open_request ? (
        <>
          <p className="auth-copy">{tr("confirmNote")}</p>
          <button
            type="button"
            onClick={() => void change({ op: "confirm", request_id: row.open_request!.id })}
          >
            {tr("confirm")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void change({ op: "request", capability: row.capability })}
        >
          {tr("askLimits")}
        </button>
      )}
    </li>
  );
}
