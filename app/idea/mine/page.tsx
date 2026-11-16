// /idea/mine — the idea kept as this business (TASKS-IDEAS part 2). Before
// launch: the plan worked through, its test with the lines set when it was
// made, every result recorded against them, and the launch. After: the
// launch date, the first connector to make (I-52), and the plan beside
// the measured month (I-51) — the plan kept as it was.

import type { Metadata } from "next";
import Link from "next/link";
import { LaunchIdea, RecordResult } from "../../../components/ideas/IdeaActions";
import { IdeaResultView } from "../../../components/ideas/IdeaResultView";
import { resolveAccess } from "../../../lib/auth/access";
import { presentMoney } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { ideaPlanVsActual, keptIdea } from "../../../lib/ideas/keep";
import { firstConnector } from "../../../lib/ideas/progress";
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
      <main className="auth-stage">
        <div className="statement-col">
          <section className="card">
            <p className="auth-copy">{tr(access ? "mine.notIdea" : "mine.signedOut")}</p>
            <Link className="act" href={access ? "/idea" : "/login"}>
              {tr(access ? "again" : "keep.signInLink")}
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const a = idea.answers;
  const r = idea.result;
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const vs = await ideaPlanVsActual(access.profile_id, idea);
  const money = (minor: number, currency: string) =>
    presentMoney({ amount_minor: minor, currency }, locale, { whole: true });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const connector =
    a.revenue_model === "recruitment" ? null : firstConnector(a.revenue_model, a.sector);

  return (
    <main className="auth-stage">
      <div className="statement-col">
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

        {idea.kind === "idea" && (
          <section className="card">
            <h2 className="idea-h">{tr("launch.title")}</h2>
            <p className="auth-copy">{tr("launch.body")}</p>
            <LaunchIdea />
          </section>
        )}
      </div>
    </main>
  );
}
