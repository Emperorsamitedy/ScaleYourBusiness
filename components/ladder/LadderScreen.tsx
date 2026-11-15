"use client";

// The Trust Ladder screen (the v1 spec §4.6; its look is specs/ux-spec-v1.md
// §3, "The Trust Ladder screen"). Reads /api/ladder; every change is a POST
// the server checks against the ledger's evidence, so nothing here decides
// anything — a raise the evidence doesn't support is refused there,
// whatever this page shows.
//
// One sheet is the ladder: the four stations are columns, and every kind
// of action is a row whose marker sits in the column it has reached. A row
// opens to show what the next step needs, rule by rule, and its controls.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import type { LadderOverview, LadderRow } from "../../lib/ladder/overview";
import {
  STATIONS,
  cellState,
  groupRows,
  highestOpen,
  nextMove,
  sharedCeiling,
  stationCounts,
} from "./ladder-view";

/** Rules that read differently met or unmet carry the state in their key. */
const SPLIT_RULES = new Set(["connector_healthy", "net_positive", "no_big_loss", "caps_set"]);
function ruleKey(rule: string, met: boolean): string {
  return SPLIT_RULES.has(rule) ? `rule.${rule}.${met ? "met" : "unmet"}` : `rule.${rule}`;
}

type Change = (body: Record<string, unknown>) => Promise<void>;

export function LadderScreen() {
  const { tr, locale } = useTr("ladder");
  const [view, setView] = useState<LadderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/ladder");
    if (res.ok) setView((await res.json()) as LadderOverview);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change: Change = async (body) => {
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
  };

  if (view === null) return <main className="screen ladder" aria-busy="true" />;

  const n = (v: number) => num(v, 0, locale);
  const counts = stationCounts(view.rows);
  const top = highestOpen(view.rows);
  const ceiling = sharedCeiling(view.rows);

  return (
    <main className="screen ladder">
      <PageHead kicker={tr("kicker")} title={tr("title")}>
        <p className="tl-intro">{tr("intro")}</p>
      </PageHead>

      {view.notices.map((notice) => {
        const p = (notice.payload ?? {}) as { capability?: string; provider?: string };
        return (
          <p key={notice.id} className="tl-notice" role="status">
            <span>
              {notice.kind === "auto_demotion"
                ? tr("notice.auto_demotion", { capability: p.capability ?? "" })
                : tr("notice.connector_demotion", { provider: p.provider ?? "" })}
            </span>
            <button
              type="button"
              className="act"
              onClick={() => void change({ op: "seen", notice_id: notice.id })}
            >
              {tr("notice.seen")}
            </button>
          </p>
        );
      })}
      {error && (
        <p className="tl-notice alarm" role="alert">
          {error}
        </p>
      )}

      <section className="cs tl" aria-label={tr("kicker")}>
        <div className="tl-steps tl-grid">
          <span className="tl-hdr">{tr("col.action")}</span>
          <ol className="tl-cols">
            {STATIONS.map((s) => {
              const here = counts[s - 1] ?? 0;
              const shut = s > top;
              return (
                <li key={s} className={`tl-col${here > 0 ? " has" : ""}${shut ? " shut" : ""}`}>
                  <b>{tr("stepN", { n: n(s) })}</b>
                  <span>{tr(`station.${s}`)}</span>
                  <small>{shut ? tr("notOpen") : tr("linesHere", { count: here })}</small>
                </li>
              );
            })}
          </ol>
          <span className="tl-hdr r">{tr("col.record")}</span>
          <span />
        </div>

        {groupRows(view.rows).map((g) => (
          <div key={g.key} className="tl-group">
            <h2 className="tl-group-name">{tr(`group.${g.key}`)}</h2>
            <ul className="tl-rows">
              {g.rows.map((r) => (
                <Row
                  key={r.capability}
                  row={r}
                  tr={tr}
                  locale={locale}
                  open={open === r.capability}
                  toggle={() => setOpen(open === r.capability ? null : r.capability)}
                  change={change}
                />
              ))}
            </ul>
          </div>
        ))}

        <footer className="tl-foot">
          <span>{ceiling === null ? tr("foot.own") : tr("foot.ceiling", { n: n(ceiling) })}</span>
          <Link href="/shadow">{tr("shadowLink")} →</Link>
        </footer>
      </section>
    </main>
  );
}

function Row({
  row,
  tr,
  locale,
  open,
  toggle,
  change,
}: {
  row: LadderRow;
  tr: Tr;
  locale: AppLocale;
  open: boolean;
  toggle: () => void;
  change: Change;
}) {
  const n = (v: number) => num(v, 0, locale);
  const panel = `tl-more-${row.capability}`;
  return (
    <li className={`tl-row${open ? " open" : ""}`}>
      <button
        type="button"
        className="tl-row-btn tl-grid"
        aria-expanded={open}
        aria-controls={panel}
        onClick={toggle}
      >
        <span className="tl-name">
          <b>{tr(`capability.${row.capability}`)}</b>
          <span>{tr(`station.${row.station}`)}</span>
        </span>
        <span
          className="tl-track"
          role="img"
          aria-label={tr("trackAria", { n: n(row.station), total: n(STATIONS.length) })}
        >
          {STATIONS.map((s) => (
            <span key={s} className={`tl-cell ${cellState(row, s)}`}>
              {s === row.station ? n(s) : ""}
            </span>
          ))}
        </span>
        <span className="tl-rec">
          {row.record.closed === 0 ? (
            <span className="none">{tr("rec.none")}</span>
          ) : (
            <>
              <span>{tr("rec.measured", { count: row.record.closed })}</span>
              <span>
                <span className="gain">{tr("rec.gains", { count: row.record.gains })}</span>
                {" · "}
                <span className="loss">{tr("rec.losses", { count: row.record.losses })}</span>
              </span>
            </>
          )}
        </span>
        <span className="tl-chev" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && <More id={panel} row={row} tr={tr} locale={locale} change={change} />}
    </li>
  );
}

function More({
  id,
  row,
  tr,
  locale,
  change,
}: {
  id: string;
  row: LadderRow;
  tr: Tr;
  locale: AppLocale;
  change: Change;
}) {
  const move = nextMove(row);
  const station = (to: number) => void change({ op: "station", capability: row.capability, to });
  return (
    <div className="tl-more" id={id}>
      <div className="tl-more-body">
        {row.next && (
          <div className="tl-need">
            <h3>{tr("needs", { n: num(row.next.to, 0, locale) })}</h3>
            <ul>
              {row.next.checks.map((c, i) => (
                <li key={`${c.rule}-${i}`}>
                  <span className={`flag ${c.met ? "ok" : "drift"}`}>
                    {tr(c.met ? "met" : "notMet")}
                  </span>
                  <span>{tr(ruleKey(c.rule, c.met), c.params ?? {})}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {move === "confirm" && <p className="tl-hint">{tr("confirmNote")}</p>}
        <div className="tl-acts">
          {move === "raise" && (
            <button type="button" className="act solid" onClick={() => station(row.station + 1)}>
              {tr("raise")}
            </button>
          )}
          {move === "ask" && (
            <button
              type="button"
              className="act solid"
              onClick={() => void change({ op: "request", capability: row.capability })}
            >
              {tr("askLimits")}
            </button>
          )}
          {move === "confirm" && row.open_request && (
            <button
              type="button"
              className="act solid"
              onClick={() => void change({ op: "confirm", request_id: row.open_request?.id })}
            >
              {tr("confirm")}
            </button>
          )}
          {row.station > 1 && (
            <button type="button" className="act" onClick={() => station(row.station - 1)}>
              {tr("lower")}
            </button>
          )}
          {move === "ceiling" && (
            <span className="tl-hint">{tr("ceiling", { station: row.ceiling })}</span>
          )}
          {move === "wait" && <span className="tl-hint">{tr("waitHint")}</span>}
        </div>
      </div>
    </div>
  );
}
