// /billing — the owner's plan (v1 spec §8.3–§8.5): the tier and its price,
// where it stands, the verified-euro counter, the guarantee's live progress
// on Autonomous ("€1,340 verified this quarter against a €897 fee — 1.5×,
// threshold 3×"), the card, and the cancellation flow with Watch offered
// first. A dormant pause says why and how to start again.

import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { BillingButton } from "../../components/billing/BillingButton";
import { CancelFlow } from "../../components/billing/CancelFlow";
import { Bullet } from "../../components/charts/Viz";
import { db } from "../../db";
import { subscriptions } from "../../db/schema";
import { resolveAccess } from "../../lib/auth/access";
import { guaranteeProgress } from "../../lib/billing/guarantee-run";
import { periodAmount, planPrices } from "../../lib/billing/plans";
import { scaleMinorBy } from "../../lib/core/money";
import { dayMonthYear, presentMoney } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { headlineCounter } from "../../lib/ledger/counter";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "billing")("meta.title") };
}
export const dynamic = "force-dynamic";

const STOPS: Record<string, string[]> = {
  watch: ["watching", "diagnosis", "statement"],
  act: ["watching", "diagnosis", "statement", "acting"],
  autonomous: ["watching", "diagnosis", "statement", "acting", "limits", "guarantee"],
  extra_business: ["watching", "diagnosis", "statement"],
};

export default async function BillingPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "billing");
  const access = await resolveAccess();
  const words = { failed: tr("failed"), notArmed: tr("notArmed") };
  const [sub] = access
    ? await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.profile_id, access.profile_id),
            ne(subscriptions.status, "canceled"),
          ),
        )
        .orderBy(desc(subscriptions.locked_at))
        .limit(1)
    : [];
  if (!access || !sub) {
    return (
      <main className="auth-stage">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <p className="auth-copy">{tr("none")}</p>
          <p className="auth-copy">
            <Link href="/pricing">{tr("plans")}</Link>
          </p>
        </section>
      </main>
    );
  }
  const money = (amount_minor: number, currency: string) =>
    presentMoney({ amount_minor, currency }, locale, { whole: true });
  const interval = sub.billing_interval === "year" ? "year" : "month";
  const price = money(periodAmount(sub.price_amount_minor, sub.currency, interval), sub.currency);
  const counter = await headlineCounter(access.profile_id);
  const verified =
    counter.verified.length === 0
      ? money(0, sub.currency)
      : counter.verified.map((m) => money(m.amount_minor, m.currency)).join(" · ");
  const progress = await guaranteeProgress(access.profile_id);
  // Drawn only beside the sentence that prints both figures, in one currency.
  const meter =
    progress &&
    progress.outcome !== "rolled_forward" &&
    progress.fee.amount_minor > 0 &&
    progress.verified.currency === progress.fee.currency
      ? {
          verified: progress.verified.amount_minor,
          threshold: scaleMinorBy(progress.fee.amount_minor, progress.threshold_bp, 10_000),
        }
      : null;
  const watch = (await planPrices(sub.billing_country)).find((p) => p.tier === "watch");
  const list = new Intl.ListFormat([locale], { type: "conjunction" });

  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <h1 className="auth-title">
            {tr(`tier.${sub.tier}`)} ·{" "}
            {tr(interval === "year" ? "priceYear" : "priceMonth", { amount: price })}
          </h1>
          <p className="auth-copy">
            <b>{tr(`status.${sub.status}`)}</b>
            {sub.current_period_end && (
              <>
                {" "}
                {tr(sub.cancel_at_period_end ? "ends" : "renews", {
                  date: dayMonthYear(sub.current_period_end.slice(0, 10), locale),
                })}
              </>
            )}
          </p>
          <p className="auth-copy">{tr("verified", { amount: verified })}</p>
          {meter !== null && (
            <div className="billing-meter">
              <Bullet start={0} target={meter.threshold} now={meter.verified} />
            </div>
          )}
          {progress && (
            <p className="auth-copy">
              {progress.outcome === "rolled_forward"
                ? tr("progressRolled")
                : tr("progress", {
                    verified: money(progress.verified.amount_minor, progress.verified.currency),
                    fee: money(progress.fee.amount_minor, progress.fee.currency),
                    ratio: `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                      (progress.ratio_bp ?? 0) / 10_000, // not money: a multiple, shown
                    )}×`,
                  })}
            </p>
          )}
          {sub.status === "paused" && (
            <p className="auth-copy">
              {tr("resume.paused")}{" "}
              <BillingButton
                action="resume"
                label={tr("resume.button")}
                words={words}
                className="act"
              />
            </p>
          )}
          <p className="auth-copy">
            <BillingButton action="portal" label={tr("updateCard")} words={words} />
          </p>
        </section>
        {!sub.cancel_at_period_end && sub.status !== "incomplete" && (
          <section className="card">
            <CancelFlow
              words={{
                button: tr("cancel.button"),
                stops: tr("cancel.stops", {
                  list: list.format((STOPS[sub.tier] ?? STOPS.watch!).map((s) => tr(`stop.${s}`))),
                }),
                verified: tr("verified", { amount: verified }),
                offer:
                  sub.tier === "act" || sub.tier === "autonomous"
                    ? tr("downgrade.offer", {
                        amount: watch
                          ? tr("priceMonth", { amount: money(watch.monthly_minor, watch.currency) })
                          : "",
                      })
                    : null,
                downgrade: tr("downgrade.button"),
                confirm: tr("cancel.confirm"),
                keep: tr("cancel.keep"),
                ...words,
              }}
            />
          </section>
        )}
      </div>
    </main>
  );
}
