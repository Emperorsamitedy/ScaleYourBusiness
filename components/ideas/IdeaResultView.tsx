// The idea check's result (TASKS-IDEAS.md I-40): the plan's own money
// first (grade D, "your estimate"), the number it leans on most, the
// cheapest test with its lines set now, then businesses like it on record
// (grade C, Eurostat, with table and year). Never a verdict (rule 36).
// Pure: the form (client) and the shared page (server) both render it.

import type { IdeaAnswers, IdeaResult, NextTest } from "../../lib/ideas/check";
import { toMinor } from "../../lib/ideas/units";
import type { InputKey, Lever } from "../../lib/ideas/model";
import type { SectorLine, SurvivalRate } from "../../lib/ideas/sector";
import { presentMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";

type Fmt = ReturnType<typeof formatters>;

function formatters(locale: AppLocale, currency: string) {
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const count = new Intl.NumberFormat(locale);
  return {
    /** Whole units, for totals. */
    big: (minor: number) =>
      presentMoney({ amount_minor: minor, currency }, locale, { whole: true }),
    /** With cents, for one sale. */
    unit: (minor: number) => presentMoney({ amount_minor: minor, currency }, locale),
    bp: (bp: number) => pct.format(bp / 10_000), // not money: basis points as a percent
    pctOf: (v: number) => pct.format(v / 100), // not money: a published percentage
    count: (n: number) => count.format(n),
  };
}

const PER_SALE: ReadonlySet<InputKey> = new Set(["price", "variable_cost"]);

function leverValue(l: Lever, key: "stated" | "breaking_point", f: Fmt): string {
  const v = l[key];
  if (l.key === "customers") return f.count(v);
  return PER_SALE.has(l.key) ? f.unit(v) : f.big(v);
}

function survivalText(r: SurvivalRate | null, f: Fmt): string {
  return r ? f.pctOf(r.pct) : "—";
}

function SectorP({
  line,
  kind,
  tr,
  f,
}: {
  line: SectorLine;
  kind: "margin" | "perPerson";
  tr: Tr;
  f: Fmt;
}) {
  const v = (n: number) => (line.unit === "money" ? f.big(n) : f.pctOf(n));
  const reading = line.reading === "about the same" ? "same" : line.reading;
  return (
    <p className="auth-copy">
      {tr(`result.${kind}`, {
        own: v(line.own),
        bench: v(line.bench),
        cell: line.cell.words,
        reading: tr(`result.reading.${reading}`),
      })}
      {line.cell.fallback && <span className="idea-note"> {line.cell.fallback}</span>}
    </p>
  );
}

function TestP({ test, tr, f }: { test: NextTest; tr: Tr; f: Fmt }) {
  switch (test.id) {
    case "presale":
      return (
        <p className="auth-copy">
          {tr("result.test.presale", {
            weeks: String(test.weeks),
            pass: f.count(test.pass_at_least),
            fail: f.count(test.fail_below),
            count: f.count(test.break_even),
          })}
        </p>
      );
    case "pilots":
      return (
        <p className="auth-copy">
          {tr("result.test.pilots", {
            conversations: String(test.conversations),
            weeks: String(test.weeks),
            pass: String(test.pass_at_least),
            fail: String(test.fail_at_most),
          })}
        </p>
      );
    case "quotes": {
      const money = test.cost === "variable_cost" ? f.unit : f.big;
      return (
        <p className="auth-copy">
          {tr("result.test.quotes", {
            quotes: String(test.quotes),
            cost: tr(`result.test.cost.${test.cost}`),
            pass: money(test.pass_at_most_minor),
            fail: money(test.fail_at_least_minor),
          })}
        </p>
      );
    }
  }
}

export function IdeaResultView({
  result,
  answers,
  tr,
  locale,
}: {
  result: IdeaResult;
  answers: IdeaAnswers;
  tr: Tr;
  locale: AppLocale;
}) {
  if (result.status === "recruitment") {
    return (
      <section className="card entry-result idea-result" aria-live="polite">
        <span className="auth-eyebrow">{tr("result.label")}</span>
        <h2 className="auth-title">{tr("result.recruitment.title")}</h2>
        <p className="auth-copy">{tr("result.recruitment.body")}</p>
      </section>
    );
  }
  const f = formatters(locale, result.currency);
  const m = result.money;
  const c = result.currency;
  const s = result.survival;
  const countryName =
    new Intl.DisplayNames([locale], { type: "region" }).of(answers.country) ?? answers.country;

  return (
    <section className="card entry-result idea-result" aria-live="polite">
      <span className="auth-eyebrow">{tr("result.label")}</span>
      <p className="auth-copy idea-note">{tr("result.notVerdict")}</p>

      <h3 className="idea-h">{tr("result.yours")}</h3>
      {m.status === "loses_per_sale" ? (
        <p className="auth-copy">
          <b>{tr("result.losesPerSale", { amount: f.unit(m.contribution_minor) })}</b>
        </p>
      ) : (
        <>
          <p className="auth-copy">
            {tr("result.contribution", { amount: f.unit(m.contribution_minor) })}
          </p>
          <p className="entry-figure">
            {tr("result.breakEven", { count: f.count(m.break_even_customers) })}
          </p>
          {m.at_plan && answers.customers_month !== null && !m.short_at_plan && (
            <p className="auth-copy">
              {tr("result.atPlan", {
                customers: f.count(answers.customers_month),
                revenue: f.big(m.at_plan.revenue_minor),
                profit: f.big(m.at_plan.profit_minor),
                margin: m.at_plan.margin_bp === null ? "—" : f.bp(m.at_plan.margin_bp),
              })}
            </p>
          )}
          {m.short_at_plan && m.at_plan && answers.customers_month !== null && (
            <>
              <p className="auth-copy">
                <b>
                  {tr("result.short", {
                    customers: f.count(answers.customers_month),
                    loss: f.big(-m.at_plan.profit_minor),
                  })}
                </b>
              </p>
              <ul className="idea-list">
                {m.levers.map((l) => (
                  <li key={l.key}>
                    {tr(`result.lever.${l.key}`, { to: leverValue(l, "breaking_point", f) })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {m.cash && (
            <>
              <p className="auth-copy">
                {tr("result.cash.start", {
                  capital: f.big(toMinor(answers.capital ?? 0, c)),
                  startup: f.big(toMinor(answers.startup ?? 0, c)),
                  left: f.big(m.cash.start_minor),
                })}{" "}
                {m.cash.runs_out_month === 0
                  ? tr("result.cash.dayOne", { shortfall: f.big(m.cash.shortfall_minor) })
                  : m.cash.runs_out_month !== null
                    ? tr("result.cash.runsOut", {
                        month: String(m.cash.runs_out_month),
                        shortfall: f.big(m.cash.shortfall_minor),
                      })
                    : tr("result.cash.holds", {
                        month: String(m.cash.lowest_month),
                        lowest: f.big(m.cash.lowest_minor),
                      })}
              </p>
              <p className="auth-copy">
                {m.cash.covers_costs_month !== null
                  ? tr("result.cash.covers", { month: String(m.cash.covers_costs_month) })
                  : tr("result.cash.neverCovers")}
              </p>
            </>
          )}

          {!m.short_at_plan && (
            <>
              <h3 className="idea-h">{tr("result.riskiest.title")}</h3>
              <p className="auth-copy">
                <b>
                  {m.riskiest_basis === "unknown"
                    ? tr("result.riskiest.unknown", { count: f.count(m.break_even_customers) })
                    : m.riskiest_basis === "above_sector" && result.per_person
                      ? tr("result.riskiest.above_sector", {
                          own: f.big(result.per_person.own),
                          bench: f.big(result.per_person.bench),
                          cell: result.per_person.cell.words,
                        })
                      : (() => {
                          const l = m.levers.find((x) => x.key === m.riskiest);
                          return l
                            ? tr(`result.riskiest.${l.key}`, {
                                room: f.bp(Math.abs(l.room_bp)),
                                to: leverValue(l, "breaking_point", f),
                              })
                            : null;
                        })()}
                </b>
              </p>
              {m.levers.length > 0 && (
                <>
                  <p className="auth-copy idea-note">{tr("result.room.title")}</p>
                  <ul className="idea-list">
                    {m.levers.map((l) => (
                      <li key={l.key}>
                        {tr(`result.room.${l.key}`, {
                          stated: leverValue(l, "stated", f),
                          to: leverValue(l, "breaking_point", f),
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}

      <h3 className="idea-h">{tr("result.test.title")}</h3>
      {result.test ? (
        <>
          <TestP test={result.test} tr={tr} f={f} />
          <p className="auth-copy idea-note">{tr("result.test.setNow")}</p>
        </>
      ) : (
        <p className="auth-copy">{tr("result.test.none")}</p>
      )}

      <h3 className="idea-h">{tr("result.market")}</h3>
      {s.status === "shown" ? (
        <>
          <p className="auth-copy">
            {tr("result.survival.shown", {
              group: s.group,
              country: countryName,
              y1: survivalText(s.y1, f),
              y3: survivalText(s.y3, f),
              y5: survivalText(s.y5, f),
            })}
          </p>
          <p className="auth-copy idea-note">
            {tr("result.survival.about")} {s.parent && `${tr("result.survival.parent")} `}
            {[s.y1, s.y3, s.y5].some((r) => r?.flag === "b") && `${tr("result.survival.break")} `}
            {tr("result.survival.source", {
              dataset: s.dataset,
              year: String(s.y5?.year ?? s.y3?.year ?? s.y1?.year ?? ""),
            })}
          </p>
        </>
      ) : (
        <p className="auth-copy">{tr(`result.survival.${s.why}`)}</p>
      )}
      {result.margin && <SectorP line={result.margin} kind="margin" tr={tr} f={f} />}
      {result.per_person && <SectorP line={result.per_person} kind="perPerson" tr={tr} f={f} />}
      <p className="auth-copy idea-note">
        {tr("result.sources", { datasets: "bd_9bd_sz_cl_r2, sbs_sc_ovw" })}
      </p>
    </section>
  );
}
