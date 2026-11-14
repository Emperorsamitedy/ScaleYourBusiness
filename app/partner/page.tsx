// /partner — the Partner Console (v1 spec §7): the firm's book, sorted by the
// size of leak found (§7.2), the firm-level proof ledger (§7.4), and — for a
// principal — the branding (§7.3) and the people at the firm. A signed-in
// person with no firm yet sets one up here.

import type { Metadata } from "next";
import Link from "next/link";
import { PostForm } from "../../components/partner/PostForm";
import { loadFactWords } from "../../lib/bank/words";
import { dayMonthYear, presentMoney } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { firmOf } from "../../lib/partners/access";
import { bookView, firmRollup } from "../../lib/partners/book";
import { FIRM_TYPES } from "../../lib/partners/firm";
import { partnerSession } from "../../lib/partners/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "partner")("meta.title") };
}
export const dynamic = "force-dynamic";

const COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
];

export default async function PartnerPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "partner");
  const session = await partnerSession();
  const failed = tr("failed", { why: "{why}" });
  if (!session) {
    return (
      <main className="auth-stage">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <p className="auth-copy">{tr("noSession")}</p>
          <p className="auth-copy">
            <Link href="/login">→</Link>
          </p>
        </section>
      </main>
    );
  }
  const mine = await firmOf(session.user_id);
  if (!mine) {
    const regions = new Intl.DisplayNames([locale], { type: "region" });
    return (
      <main className="auth-stage">
        <div className="statement-col">
          <section className="card">
            <span className="auth-eyebrow">{tr("kicker")}</span>
            <h1 className="auth-title">{tr("create.title")}</h1>
            <p className="auth-copy">{tr("create.intro")}</p>
            <PostForm
              endpoint="/api/partner"
              fixed={{ action: "create_firm" }}
              fields={[
                { name: "name", label: tr("create.name"), kind: "text" },
                {
                  name: "country",
                  label: tr("create.country"),
                  kind: "select",
                  initial: "HU",
                  options: COUNTRIES.map((c) => ({ value: c, label: regions.of(c) ?? c })),
                },
                {
                  name: "type",
                  label: tr("create.type"),
                  kind: "select",
                  initial: "accountancy",
                  options: FIRM_TYPES.map((t) => ({ value: t, label: tr(`type.${t}`) })),
                },
              ]}
              submit={tr("create.submit")}
              failed={failed}
            />
          </section>
        </div>
      </main>
    );
  }

  const [book, rollup, words] = await Promise.all([
    bookView(session.user_id),
    firmRollup(mine.firm.id, session.user_id),
    loadFactWords(locale),
  ]);
  const english = await loadFactWords("en");
  const money = (m: { amount_minor: number; currency: string }) =>
    presentMoney(m, locale, { whole: true });
  const sector = (code: string | null) =>
    code
      ? (words.value("identity.business_type", code) ??
        english.value("identity.business_type", code) ??
        code)
      : "—";
  return (
    <main className="screen partner-screen">
      <section className="card">
        <span className="auth-eyebrow">
          {tr("kicker")} · {mine.firm.name}
        </span>
        <h1 className="auth-title">{tr("book.title")}</h1>
        <p className="auth-copy">
          {tr("book.rollup", { amount: rollup.verified.map(money).join(" · ") })}
        </p>
        <p className="auth-copy">{tr("book.clients", { count: String(rollup.clients_active) })}</p>
        {mine.role !== "staff" && (
          <p className="auth-copy">
            <Link href="/partner/import">{tr("import.link")}</Link>
            {" · "}
            <Link href="/partner/nav">{tr("nav.link")}</Link>
          </p>
        )}
      </section>
      {book.length === 0 ? (
        <section className="card">
          <p className="auth-copy">{tr("book.empty")}</p>
        </section>
      ) : (
        <div className="partner-table-wrap">
          <table className="rt partner-table">
            <thead>
              <tr>
                {[
                  "client",
                  "sector",
                  "grade",
                  "leaks",
                  "largest",
                  "verified",
                  "awaiting",
                  "health",
                  "activity",
                ].map((c) => (
                  <th key={c} scope="col">
                    {tr(`col.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {book.map((r) => (
                <tr key={r.profile_id}>
                  <td>
                    <Link href={`/partner/clients/${r.profile_id}`}>{r.name ?? tr("unnamed")}</Link>
                  </td>
                  <td>{sector(r.sector)}</td>
                  <td>{r.grade ?? "—"}</td>
                  <td>
                    {r.leaks_open}
                    {r.leaks_money.length > 0
                      ? ` · ${r.leaks_money.map((m) => `${money(m.low)}–${money(m.high)}`).join(" · ")}`
                      : r.leaks_open > 0
                        ? ` · ${tr("hidden")}`
                        : ""}
                  </td>
                  <td>
                    {r.largest_leak
                      ? `${r.largest_leak.title}${r.largest_leak.high ? ` · ${money(r.largest_leak.high)}` : ""}`
                      : "—"}
                  </td>
                  <td>
                    {r.verified_quarter.length > 0
                      ? r.verified_quarter.map(money).join(" · ")
                      : "—"}
                  </td>
                  <td>{r.awaiting_approval}</td>
                  <td>{tr(`health.${r.health}`)}</td>
                  <td>
                    {r.last_activity ? dayMonthYear(r.last_activity.slice(0, 10), locale) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mine.role === "principal" && (
        <div className="statement-col partner-settings">
          <section className="card">
            <span className="auth-eyebrow">{tr("settings.title")}</span>
            <PostForm
              endpoint="/api/partner"
              fixed={{ action: "white_label" }}
              fields={[
                {
                  name: "logo_url",
                  label: tr("settings.logo"),
                  kind: "text",
                  initial: mine.firm.white_label.logo_url ?? "",
                },
                {
                  name: "primary_color",
                  label: tr("settings.primary"),
                  kind: "text",
                  initial: mine.firm.white_label.primary_color ?? "",
                },
                {
                  name: "accent_color",
                  label: tr("settings.accent"),
                  kind: "text",
                  initial: mine.firm.white_label.accent_color ?? "",
                },
                {
                  name: "sender_domain",
                  label: tr("settings.domain"),
                  kind: "text",
                  initial: mine.firm.white_label.sender_domain ?? "",
                },
              ]}
              submit={tr("settings.save")}
              done={tr("done")}
              failed={failed}
              className="ghost"
            />
          </section>
          <section className="card">
            <span className="auth-eyebrow">{tr("members.title")}</span>
            <PostForm
              endpoint="/api/partner"
              fixed={{ action: "add_member" }}
              fields={[
                { name: "email", label: tr("members.email"), kind: "text" },
                {
                  name: "role",
                  label: "",
                  kind: "select",
                  initial: "staff",
                  options: [
                    { value: "manager", label: tr("role.manager") },
                    { value: "staff", label: tr("role.staff") },
                  ],
                },
              ]}
              submit={tr("members.add")}
              done={tr("done")}
              failed={failed}
              className="ghost"
            />
          </section>
        </div>
      )}
    </main>
  );
}
