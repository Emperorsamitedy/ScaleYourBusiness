// /statement — the monthly ledger statement and the leak register (the v1
// spec §6.4, §6.6; P7-52/53): what SYB did this month, what it was worth
// with the losses in plain sight, what it cost, what is queued and the one
// decision waiting — then every leak the diagnosis has found, where it
// stands. Read-only: a leak is marked fixed only with a verified gain.

import type { Metadata } from "next";
import Link from "next/link";
import { resolveAccess } from "../../lib/auth/access";
import type { Grade } from "../../lib/core/grade";
import { headlineMoneyAllowed } from "../../lib/diagnosis/diagnosis-grade";
import { leaksOf } from "../../lib/diagnosis/leaks";
import type { Leak } from "../../lib/diagnosis/leaks";
import { monthlyStatement } from "../../lib/diagnosis/statement";
import { presentMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";

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
  const access = await resolveAccess();
  if (!access) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">{tr("none")}</p>
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

  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("title")}</span>
          <h1 className="auth-title">{monthWords}</h1>
          <ul className="shadow-summary">
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
            <p className="auth-copy">
              {tr("decision")} <Link href="/proposals">{s.decision.summary || tr("open")}</Link>
            </p>
          ) : (
            <p className="auth-copy">{tr("noDecision")}</p>
          )}
        </section>

        <section className="card">
          <span className="auth-eyebrow">{tr("leaks.title")}</span>
          {sorted.length === 0 ? (
            <p className="auth-copy">{tr("leaks.none")}</p>
          ) : (
            <ul className="shadow-summary">
              {sorted.map((l) => (
                <li key={l.id}>
                  <b>{l.title}</b> — {tr(`leaks.status.${l.status}`)}
                  {/* §6.2: a leak's money shows only at grade A or B; below, the grade says why not. */}
                  {headlineMoneyAllowed(l.grade as Grade) &&
                    l.currency !== null &&
                    l.low_minor !== null &&
                    l.high_minor !== null && (
                      <>
                        {" · "}
                        {tr("leaks.range", {
                          low: presentMoney(
                            { amount_minor: l.low_minor, currency: l.currency },
                            locale,
                            { whole: true },
                          ),
                          high: presentMoney(
                            { amount_minor: l.high_minor, currency: l.currency },
                            locale,
                            { whole: true },
                          ),
                        })}
                      </>
                    )}
                  {" · "}
                  {tr("leaks.grade", { grade: l.grade })}
                </li>
              ))}
            </ul>
          )}
          <p className="auth-copy">{tr("leaks.rule")}</p>
        </section>
      </div>
    </main>
  );
}
