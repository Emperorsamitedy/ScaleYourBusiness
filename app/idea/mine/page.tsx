// /idea/mine — the idea kept as this business (TASKS-IDEAS part 2). Before
// launch: the plan worked through, its test with the lines set when it was
// made, every result recorded against them, and the launch. After: the
// launch date, the first connector to make (I-52), and the plan beside
// the measured month (I-51) — the plan kept as it was.
// On the entrance's card since 2026-11-20, like the idea check itself.

import type { Metadata } from "next";
import Link from "next/link";
import { LaunchIdea, MakeTestPage, RecordResult } from "../../../components/ideas/IdeaActions";
import { ShareLink } from "../../../components/ladder/ShareLink";
import { testPageOf, testPageResult } from "../../../lib/ideas/testpage";
import { IdeaResultView } from "../../../components/ideas/IdeaResultView";
import { resolveAccess } from "../../../lib/auth/access";
import { presentMoney } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { freshLocal } from "../../../lib/ideas/check";
import { ideaPlanVsActual, keptIdea } from "../../../lib/ideas/keep";
import { firstConnector } from "../../../lib/ideas/progress";
import { Logo } from "../../../components/brand/Mark";
import "../../auth-v2.css";
import "../../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ideas")("mine.title") };
}
export const dynamic = "force-dynamic";

export default async function MyIdeaPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const access = await resolveAccess();
  const idea = access ? await keptIdea(access.profile_id) : null;
  if (!access || !idea) {
    return (
      <div className="ax ax-signin ax-dress">
        <Link href="/" className="ax-logo">
          <Logo onDark />
        </Link>
        <main className="ax-card ax-card-wide ax-dress-stack">
          <section className="card">
            <p className="auth-copy">{tr(access ? "mine.notIdea" : "mine.signedOut")}</p>
            <Link className="act" href={access ? "/idea" : "/login"}>
              {tr(access ? "again" : "keep.signInLink")}
            </Link>
          </section>
        </main>
      </div>
    );
  }

  const a = idea.answers;
  const r = await freshLocal(idea.result, a);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const pva = await ideaPlanVsActual(access.profile_id, idea);
  const page = await testPageOf(access.profile_id);
  const pageResult = page ? await testPageResult(page) : null;
  const vs = pva?.revenue ?? null;
  const money = (minor: number, currency: string) =>
    presentMoney({ amount_minor: minor, currency }, locale, { whole: true });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const count = new Intl.NumberFormat(locale);
  const unitMoney = (minor: number, currency: string) =>
    presentMoney({ amount_minor: minor, currency }, locale);
  const connector =
    a.revenue_model === "recruitment" ? null : firstConnector(a.revenue_model, a.sector);

  return (
    <div className="ax ax-signin ax-dress">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card ax-card-wide ax-dress-stack">
        <section className="card">
          <span className="auth-eyebrow">{tr("mine.kicker")}</span>
          <h1 className="auth-title">
            {tr(idea.kind === "idea" ? "mine.titleIdea" : "mine.titleLaunched")}
          </h1>
          {idea.launched_at && (
            <p className="auth-copy">
              {tr("mine.launchedOn", { date: dates.format(new Date(idea.launched_at)) })}
            </p>
          )}
        </section>

        {idea.kind === "operating" && (
          <section className="card">
            <h2 className="idea-h">{tr("actual.title")}</h2>
            {vs?.status === "compared" ? (
              <p className="auth-copy">
                {tr("actual.compared", {
                  planned: money(vs.planned_minor, vs.currency),
                  actual: money(vs.actual_minor, vs.currency),
                  days: String(vs.days_measured),
                  gap: pct.format(vs.delta_bp / 10_000), // not money: basis points as a percent
                })}
              </p>
            ) : vs?.status === "too_early" ? (
              <p className="auth-copy">
                {tr("actual.tooEarly", {
                  days: String(vs.days_measured),
                  needed: String(vs.needed),
                })}
              </p>
            ) : vs?.status === "other_currency" ? (
              <p className="auth-copy">
                {tr("actual.otherCurrency", { planned: vs.planned, measured: vs.measured })}
              </p>
            ) : (
              <p className="auth-copy">{tr("actual.noPlan")}</p>
            )}
            {vs?.status === "compared" && (pva?.assumptions.length ?? 0) > 0 && (
              <ul className="idea-list">
                {pva!.assumptions.map((l) => (
                  <li key={l.key}>
                    {l.status === "compared" && l.key === "customers"
                      ? tr("actual.customers", {
                          planned: count.format(l.planned),
                          actual: count.format(l.actual),
                          gap: pct.format(l.delta_bp / 10_000), // not money: basis points as a percent
                        })
                      : l.status === "compared" && l.key === "price"
                        ? tr("actual.price", {
                            planned: unitMoney(l.planned_minor, l.currency),
                            actual: unitMoney(l.actual_minor, l.currency),
                            gap: pct.format(l.delta_bp / 10_000), // not money: basis points as a percent
                          })
                        : l.status === "not_comparable"
                          ? tr(`actual.not.${l.key}.${l.why}`)
                          : tr("actual.costs")}
                  </li>
                ))}
              </ul>
            )}
            <p className="auth-copy idea-note">{tr("actual.kept")}</p>
            {connector && (
              <p className="auth-copy">
                {tr("launch.connect", { provider: tr(`provider.${connector}`) })}{" "}
                <Link href="/connections">{tr("launch.connectLink")}</Link>
              </p>
            )}
          </section>
        )}

        <IdeaResultView result={r} answers={a} tr={tr} locale={locale} />

        {idea.kind === "idea" && r.status === "worked" && r.test && (
          <section className="card">
            <h2 className="idea-h">{tr("record.title")}</h2>
            {idea.results.length > 0 && (
              <ul className="idea-list">
                {idea.results.map((x) => (
                  <li key={x.recorded_at}>
                    {tr("record.line", {
                      date: dates.format(new Date(x.recorded_at)),
                      value:
                        r.test?.id === "quotes"
                          ? money(x.observed, r.currency)
                          : String(x.observed),
                      reading: tr(`record.reading.${x.reading}`),
                    })}
                  </li>
                ))}
              </ul>
            )}
            <RecordResult test={r.test} currency={r.currency} />
          </section>
        )}

        {idea.kind === "idea" && r.status === "worked" && a.price !== null && (
          <section className="card">
            <h2 className="idea-h">{tr("testPage.sectionTitle")}</h2>
            {page && pageResult ? (
              <>
                <p className="auth-copy">{tr("testPage.yours", { pitch: page.pitch })}</p>
                <ShareLink
                  path={`/t/${page.slug}`}
                  label={tr("testPage.copy")}
                  done={tr("copied")}
                />
                <p className="auth-copy">
                  {tr("testPage.counts", {
                    visits: count.format(pageResult.visits),
                    interested: count.format(pageResult.interested),
                  })}{" "}
                  {pageResult.reading === "too_few"
                    ? tr("testPage.tooFew", { min: count.format(page.min_visits) })
                    : tr(`testPage.reading.${pageResult.reading}`, {
                        rate: pct.format((pageResult.rate_bp ?? 0) / 10_000), // not money: a rate
                      })}
                </p>
                <p className="auth-copy idea-note">
                  {tr("testPage.lines", {
                    min: count.format(page.min_visits),
                    pass: pct.format(page.pass_rate_bp / 10_000), // not money: a rate
                    fail: pct.format(page.fail_below_rate_bp / 10_000), // not money: a rate
                  })}
                </p>
              </>
            ) : (
              <>
                <p className="auth-copy">{tr("testPage.why")}</p>
                <MakeTestPage />
              </>
            )}
          </section>
        )}

        {idea.kind === "idea" && (
          <section className="card">
            <h2 className="idea-h">{tr("launch.title")}</h2>
            <p className="auth-copy">{tr("launch.body")}</p>
            <LaunchIdea />
          </section>
        )}
      </main>
    </div>
  );
}
