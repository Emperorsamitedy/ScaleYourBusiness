// /statement — the monthly ledger statement and the leak register (the v1
// spec §6.4, §6.6; P7-52/53): what SYB did this month, what it was worth
// with the losses in plain sight, what it cost, what is queued and the one
// decision waiting — then every leak the diagnosis has found, where it
// stands. Read-only: a leak is marked fixed only with a verified gain.

import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { HBars } from "../../components/charts/Viz";
import { PageHead, SheetCard } from "../../components/sheet/PageHead";
import { resolveAccess } from "../../lib/auth/access";
import type { Grade } from "../../lib/core/grade";
import { headlineMoneyAllowed } from "../../lib/diagnosis/diagnosis-grade";
import { leaksOf } from "../../lib/diagnosis/leaks";
import type { Leak } from "../../lib/diagnosis/leaks";
import { monthlyStatement } from "../../lib/diagnosis/statement";
import { leakBars, worthBars } from "../../lib/diagnosis/statement-bars";
import { presentMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../plain.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "statement")("meta.title") };
}
export const dynamic = "force-dynamic";

type MoneyList = readonly { amount_minor: number; currency: string }[];

function amounts(list: MoneyList, locale: AppLocale, none: string): string {
  return list.length === 0
    ? none
    : list.map((m) => presentMoney(m, locale, { whole: true })).join(" · ");
}

/** §6.2: a leak's money shows only at grade A or B; below, the grade says why not. */
function shownRange(l: Leak): { currency: string; low_minor: number; high_minor: number } | null {
  return headlineMoneyAllowed(l.grade as Grade) &&
    l.currency !== null &&
    l.low_minor !== null &&
    l.high_minor !== null
    ? { currency: l.currency, low_minor: l.low_minor, high_minor: l.high_minor }
    : null;
}

const ORDER: Record<Leak["status"], number> = {
  open: 0,
  in_progress: 1,
  accepted: 2,
  fixed_and_verified: 3,
};

export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const locale = await requestLocale();
  const tr = trFor(locale, "statement");
  const nav = trFor(locale, "nav");
  // Where this screen sits, in the menu's own words.
  const kicker = `${nav("group.business")} · ${nav("item.statement")}`;
  const access = await resolveAccess();
  if (!access) {
    return (
      <main className="screen pg">
        <PageHead kicker={kicker} title={tr("none")} />
      </main>
    );
  }
  const asked = (await searchParams).month;
  const month = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : new Date().toISOString().slice(0, 7);
  const [s, leaks] = await Promise.all([
    monthlyStatement(access.profile_id, month),
    leaksOf(access.profile_id),
  ]);
  const monthWords = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
  const dash = tr("nothing");
  const sorted = [...leaks].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.created_at.localeCompare(b.created_at),
  );
  const whole = (m: { amount_minor: number; currency: string }) =>
    presentMoney(m, locale, { whole: true });
  const rangeWords = (r: { currency: string; low_minor: number; high_minor: number }) =>
    tr("leaks.range", {
      low: whole({ amount_minor: r.low_minor, currency: r.currency }),
      high: whole({ amount_minor: r.high_minor, currency: r.currency }),
    });
  const worth = worthBars(s.worth);
  const listed = sorted.map((leak) => ({ leak, range: shownRange(leak) }));
  const ranged = new Map(
    listed.flatMap(({ leak, range }) => (range ? [[leak.id, { leak, range }] as const] : [])),
  );
  const leakBlocks = leakBars([...ranged].map(([key, { range }]) => ({ key, ...range })));

  return (
    <main className="screen pg">
      <PageHead kicker={kicker} title={monthWords} />
      <div className="pg-stack">
        <SheetCard>
          {worth.length > 0 && (
            <div className="card-viz">
              {worth.map((b) => (
                <Fragment key={b.currency}>
                  {worth.length > 1 && <p className="vz-cap">{b.currency}</p>}
                  <HBars
                    label={tr("worth", {
                      amount: amounts(
                        s.worth.verified.filter((m) => m.currency === b.currency),
                        locale,
                        dash,
                      ),
                    })}
                    max={b.max}
                    rows={b.rows.map((r) => ({
                      key: r.key,
                      label: tr(`viz.${r.key}`),
                      value: r.value,
                      display: r.money ? whole(r.money) : dash,
                      tone: r.tone,
                    }))}
                  />
                </Fragment>
              ))}
            </div>
          )}
          <ul className="pg-lines">
            <li>{tr("did", { count: s.did.actions, undone: s.did.undone })}</li>
            <li>{tr("worth", { amount: amounts(s.worth.verified, locale, dash) })}</li>
            <li>{tr("losses", { amount: amounts(s.worth.losses, locale, dash) })}</li>
            <li>
              {s.fee
                ? tr("fee", { amount: presentMoney(s.fee, locale, { whole: true }) })
                : tr("feeNone")}
            </li>
            {s.fee && <li>{tr("net", { amount: amounts(s.worth.net_of_fee, locale, dash) })}</li>}
            <li>
              {tr("unproven", {
                count: s.worth.not_yet_proven.inconclusive + s.worth.not_yet_proven.unmeasurable,
              })}
            </li>
            <li>{tr("queued", { count: s.queued })}</li>
          </ul>
          {s.decision ? (
            <p>
              {tr("decision")} <Link href="/proposals">{s.decision.summary || tr("open")}</Link>
            </p>
          ) : (
            <p>{tr("noDecision")}</p>
          )}
        </SheetCard>

        <SheetCard title={tr("leaks.title")}>
          {sorted.length === 0 ? (
            <p>{tr("leaks.none")}</p>
          ) : (
            <>
              {leakBlocks.length > 0 && (
                <div className="card-viz">
                  {leakBlocks.map((b) => (
                    <Fragment key={b.currency}>
                      {leakBlocks.length > 1 && <p className="vz-cap">{b.currency}</p>}
                      <HBars
                        label={tr("leaks.title")}
                        max={b.max}
                        rows={b.rows.flatMap((r) => {
                          const shown = ranged.get(r.key);
                          return shown
                            ? [
                                {
                                  key: r.key,
                                  label: shown.leak.title,
                                  note: tr(`leaks.status.${shown.leak.status}`),
                                  low: r.low,
                                  value: r.value,
                                  display: rangeWords(shown.range),
                                  tone: "drift" as const,
                                },
                              ]
                            : [];
                        })}
                      />
                    </Fragment>
                  ))}
                </div>
              )}
              <ul className="pg-lines">
                {listed.map(({ leak: l, range }) => (
                  <li key={l.id}>
                    <b>{l.title}</b>: {tr(`leaks.status.${l.status}`)}
                    {range && (
                      <>
                        {" · "}
                        <span className="pg-nowrap">{rangeWords(range)}</span>
                      </>
                    )}
                    {" · "}
                    {tr("leaks.grade", { grade: l.grade })}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="pg-quiet">{tr("leaks.rule")}</p>
        </SheetCard>
      </div>
    </main>
  );
}
