// /pricing — the tiers (v1 spec §8.3): prices from the price book for the
// reader's market, monthly or yearly at a fifth off, the ladder step each
// reaches, and the guarantee said plainly as Autonomous-only (§8.4).
//
// On the entrance's look since 2026-11-20 (app/auth-v2.css): the wordmark,
// the plans side by side on rounded cards, one solid button each. It had
// kept the look from before the entrance was redesigned: square cards one
// under the other with capital labels, and no way back to the front page.

import type { Metadata } from "next";
import Link from "next/link";
import { BillingButton } from "../../components/billing/BillingButton";
import { Logo } from "../../components/brand/Mark";
import { resolveAccess } from "../../lib/auth/access";
import { planPrices } from "../../lib/billing/plans";
import { countryCode } from "../../lib/core/country";
import { presentMoney } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { readCurrentField } from "../../lib/profile/field-store";
import "../auth-v2.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "pricing")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "pricing");
  const access = await resolveAccess();
  const raw = access ? await readCurrentField<string>(access.profile_id, "legal.country") : null;
  const country = (typeof raw?.value === "string" && countryCode(raw.value)) || "*";
  const prices = await planPrices(country);
  const money = (amount_minor: number, currency: string) =>
    presentMoney({ amount_minor, currency }, locale, { whole: true });
  const words = { failed: tr("failed"), notArmed: tr("notArmed") };
  const plans = prices.filter((p) => p.tier !== "extra_business");
  const extra = prices.filter((p) => p.tier === "extra_business");
  return (
    <div className="ax ax-signin ax-pricing">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-pricing-main">
        <header className="ax-pricing-head">
          <p className="ax-kicker">{tr("kicker")}</p>
          <h1 className="ax-title ax-title-lg">{tr("title")}</h1>
          <p className="ax-copy">{tr("intro")}</p>
          <p className="ax-copy">{tr("credit")}</p>
        </header>
        <div className="ax-plans">
          {plans.map((p) => (
            <section key={p.tier} className="ax-plan" aria-labelledby={`plan-${p.tier}`}>
              <h2 className="ax-plan-name" id={`plan-${p.tier}`}>
                {tr(`tier.${p.tier}`)}
              </h2>
              <p className="ax-plan-price">
                {tr("perMonth", { amount: money(p.monthly_minor, p.currency) })}
              </p>
              <p className="ax-note">
                {tr("interval.year")}:{" "}
                {tr("perYear", { amount: money(p.yearly_minor, p.currency) })}
              </p>
              <p className="ax-copy">{tr(`what.${p.tier}`)}</p>
              {p.ceiling !== null && (
                <p className="ax-copy">{tr("ceiling", { station: String(p.ceiling) })}</p>
              )}
              <p className="ax-note">{p.guarantee ? tr("guarantee") : tr("noGuarantee")}</p>
              <div className="ax-plan-acts">
                {access ? (
                  <>
                    <BillingButton
                      action="subscribe"
                      extra={{ tier: p.tier, interval: "month" }}
                      label={`${tr("choose", { tier: tr(`tier.${p.tier}`) })} · ${tr("interval.month")}`}
                      words={words}
                      className="ax-btn ax-primary"
                    />
                    <BillingButton
                      action="subscribe"
                      extra={{ tier: p.tier, interval: "year" }}
                      label={`${tr("choose", { tier: tr(`tier.${p.tier}`) })} · ${tr("interval.year")}`}
                      words={words}
                      className="ax-btn ax-door"
                    />
                  </>
                ) : (
                  <Link className="ax-btn ax-door" href="/login">
                    {tr("signIn")}
                  </Link>
                )}
              </div>
            </section>
          ))}
        </div>
        {extra.map((p) => (
          <section
            key={p.tier}
            className="ax-plan ax-plan-extra"
            aria-labelledby={`plan-${p.tier}`}
          >
            <h2 className="ax-plan-name" id={`plan-${p.tier}`}>
              {tr(`tier.${p.tier}`)}
            </h2>
            <p className="ax-plan-price">
              {tr("perMonth", { amount: money(p.monthly_minor, p.currency) })}
            </p>
            <p className="ax-note">
              {tr("interval.year")}: {tr("perYear", { amount: money(p.yearly_minor, p.currency) })}
            </p>
            <p className="ax-copy">{tr(`what.${p.tier}`)}</p>
          </section>
        ))}
        <p className="ax-switch">
          <Link href="/check">{tr("free")}</Link>
        </p>
      </main>
    </div>
  );
}
