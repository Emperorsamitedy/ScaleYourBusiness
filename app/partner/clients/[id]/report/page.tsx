// /partner/clients/[id]/report — the co-branded report (§7.3): the firm's
// logo and colours, "Prepared by [Firm] using SYB" (co-branded, never
// ghost-written), SYB's findings and recommendations with the firm's
// commentary beside each section. Money leads only at grade A or B (§6.2).
// Printable. Needs receive_reports; opening it is in the owner's trail.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { presentMoney } from "../../../../../lib/i18n/format";
import { requestLocale } from "../../../../../lib/i18n/server";
import { trFor } from "../../../../../lib/i18n/server-tr";
import { PartnerAccessError } from "../../../../../lib/partners/access";
import { COMMENTARY_SECTIONS, whiteLabelReport } from "../../../../../lib/partners/actions";
import { partnerSession } from "../../../../../lib/partners/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "partner")("meta.title"), robots: { index: false } };
}
export const dynamic = "force-dynamic";

const HEX = /^#[0-9a-fA-F]{6}$/;

export default async function WhiteLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "partner");
  const session = await partnerSession();
  if (!session || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await whiteLabelReport({ userId: session.user_id, profileId: id }).catch(
    (e: unknown) => {
      if (e instanceof PartnerAccessError) return null;
      throw e;
    },
  );
  if (!r) notFound();
  const wl = r.firm.white_label;
  const primary = wl.primary_color && HEX.test(wl.primary_color) ? wl.primary_color : undefined;
  const accent = wl.accent_color && HEX.test(wl.accent_color) ? wl.accent_color : undefined;
  const money = (m: { amount_minor: number; currency: string }) =>
    presentMoney(m, locale, { whole: true });
  return (
    <main className="wl-report" style={{ ...(primary ? { borderTopColor: primary } : {}) }}>
      <header className="wl-head">
        {wl.logo_url && <img src={wl.logo_url} alt={r.firm.name} className="wl-logo" />}
        <div>
          <h1 style={primary ? { color: primary } : undefined}>{r.business ?? tr("unnamed")}</h1>
          <p className="wl-byline" style={accent ? { color: accent } : undefined}>
            {tr("report.byline", { firm: r.firm.name })}
          </p>
          {r.report && (
            <p>
              {tr("report.version", { version: String(r.report.version), grade: r.report.grade })}
            </p>
          )}
        </div>
      </header>
      {!r.report && <p>{tr("client.noReport")}</p>}
      {COMMENTARY_SECTIONS.map((section) => {
        const own =
          section === "findings"
            ? r.report?.findings.map((f) => (
                <p key={f.title}>
                  <b>{f.title}</b> — {f.detail}
                </p>
              ))
            : section === "recommendations"
              ? r.report?.recommendations.map((x) => (
                  <p key={x.title}>
                    <b>{x.title}</b>
                    {x.low && x.high
                      ? ` · ${tr("report.range", { low: money(x.low), high: money(x.high) })}`
                      : ""}
                  </p>
                ))
              : null;
        const comment = r.commentary[section];
        if (!own?.length && !comment) return null;
        return (
          <section key={section} className="wl-section">
            <h2 style={primary ? { color: primary } : undefined}>{tr(`section.${section}`)}</h2>
            {own}
            {comment && (
              <blockquote
                className="wl-comment"
                style={accent ? { borderLeftColor: accent } : undefined}
              >
                <b>{r.firm.name}:</b> {comment}
              </blockquote>
            )}
          </section>
        );
      })}
    </main>
  );
}
