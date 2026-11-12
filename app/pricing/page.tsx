// /pricing — the tiers (v1 spec §8.3): prices from the price book for the
// reader's market, monthly or yearly at a fifth off, the ladder step each
// reaches, and the guarantee said plainly as Autonomous-only (§8.4).

import type { Metadata } from "next";
import Link from "next/link";
import { BillingButton } from "../../components/billing/BillingButton";
import { resolveAccess } from "../../lib/auth/access";
import { planPrices } from "../../lib/billing/plans";
import { countryCode } from "../../lib/core/country";
import { presentMoney } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { readCurrentField } from "../../lib/profile/field-store";

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
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <h1 className="auth-title">{tr("title")}</h1>
          <p className="auth-copy">{tr("intro")}</p>
          <p className="auth-copy">{tr("credit")}</p>
        </section>
        {prices.map((p) => (
          <section key={p.tier} className="card">
            <span className="auth-eyebrow">{tr(`tier.${p.tier}`)}</span>
            <p className="entry-figure">
              {tr("perMonth", { amount: money(p.monthly_minor, p.currency) })}
            </p>
            <p className="auth-copy">
              {tr("interval.year")}: {tr("perYear", { amount: money(p.yearly_minor, p.currency) })}
            </p>
            <p className="auth-copy">{tr(`what.${p.tier}`)}</p>
            {p.ceiling !== null && (
              <p className="auth-copy">{tr("ceiling", { station: String(p.ceiling) })}</p>
            )}
            {p.tier !== "extra_business" && (
              <p className="auth-copy">{p.guarantee ? tr("guarantee") : tr("noGuarantee")}</p>
            )}
            {p.tier !== "extra_business" &&
              (access ? (
                <p className="auth-copy">
                  <BillingButton
                    action="subscribe"
                    extra={{ tier: p.tier, interval: "month" }}
                    label={`${tr("choose", { tier: tr(`tier.${p.tier}`) })} · ${tr("interval.month")}`}
                    words={words}
                    className="act"
                  />{" "}
                  <BillingButton
                    action="subscribe"
                    extra={{ tier: p.tier, interval: "year" }}
                    label={`${tr("choose", { tier: tr(`tier.${p.tier}`) })} · ${tr("interval.year")}`}
                    words={words}
                  />
                </p>
              ) : (
                <p className="auth-copy">{tr("signIn")}</p>
              ))}
          </section>
        ))}
        <p className="auth-copy">
          <Link href="/check">{tr("free")}</Link>
        </p>
      </div>
    </main>
  );
}
