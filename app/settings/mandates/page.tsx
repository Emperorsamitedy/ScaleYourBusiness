// /settings/mandates — the owner's side of the Partner Console (§7.1): every
// firm with access, what it may do and until when, one tap to take it back;
// requests waiting for this owner's address; and every partner action on
// this business, by name and firm (§7.7).

import type { Metadata } from "next";
import { and, desc, eq, inArray } from "drizzle-orm";
import { PostForm } from "../../../components/partner/PostForm";
import { db } from "../../../db";
import { decisionLog, firms, users } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { dayMonthYear } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { mandatesOf, requestsFor } from "../../../lib/partners/mandates";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "mandates")("meta.title") };
}
export const dynamic = "force-dynamic";

const ACTS = ["approve", "commentary", "nudge", "report"];

export default async function MandatesPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "mandates");
  const scopeWords = trFor(locale, "partner");
  const access = await resolveAccess();
  if (!access?.session) {
    return (
      <main className="auth-stage">
        <section className="card">
          <p className="auth-copy">{tr("none")}</p>
        </section>
      </main>
    );
  }
  const now = Date.now();
  const [list, waiting, log] = await Promise.all([
    mandatesOf(access.profile_id),
    requestsFor(access.session.email),
    db
      .select({
        at: decisionLog.at,
        kind: decisionLog.kind,
        ref: decisionLog.ref_id,
        person: users.display_name,
      })
      .from(decisionLog)
      .innerJoin(users, eq(users.id, decisionLog.user_id))
      // The partner_action entries name the firm; a partner's approval also has its own entry.
      .where(
        and(eq(decisionLog.profile_id, access.profile_id), eq(decisionLog.kind, "partner_action")),
      )
      .orderBy(desc(decisionLog.at))
      .limit(100),
  ]);
  const firmIds = [
    ...new Set(
      log
        .map((l) => l.ref.split(":")[1])
        .filter((x): x is string => !!x && /^[0-9a-f-]{36}$/.test(x)),
    ),
  ];
  const names = new Map(
    (firmIds.length
      ? await db
          .select({ id: firms.id, name: firms.name })
          .from(firms)
          .where(inArray(firms.id, firmIds))
      : []
    ).map((f) => [f.id, f.name]),
  );
  const date = (iso: string) => dayMonthYear(iso.slice(0, 10), locale);
  const failed = tr("failed");
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <p className="auth-copy">{tr("intro")}</p>
          {list.length === 0 && <p className="auth-copy">{tr("none")}</p>}
          {list.map(({ mandate: m, firm }) => {
            const live = m.revoked_at === null && Date.parse(m.expires_at) > now;
            return (
              <div key={m.id} className="mandate-row">
                <p className="auth-copy">
                  <b>
                    {m.revoked_at
                      ? tr("revoked", { firm: firm.name, date: date(m.revoked_at) })
                      : live
                        ? tr("active", { firm: firm.name, date: date(m.expires_at) })
                        : tr("expired", { firm: firm.name, date: date(m.expires_at) })}
                  </b>
                </p>
                <p className="auth-copy">
                  {m.scopes.map((s) => scopeWords(`scope.${s}`)).join(" · ")}
                </p>
                <p className="auth-copy">{tr("evidence", { ref: m.evidence_ref })}</p>
                {live && (
                  <PostForm
                    endpoint="/api/mandates"
                    fixed={{ action: "revoke", mandate_id: m.id }}
                    submit={tr("revoke")}
                    failed={failed}
                    className="ghost"
                  />
                )}
              </div>
            );
          })}
        </section>
        {waiting.length > 0 && (
          <section className="card">
            <span className="auth-eyebrow">{tr("waiting")}</span>
            {waiting.map(({ request, firm }) => (
              <div key={request.id} className="mandate-row">
                <p className="auth-copy">
                  <b>{tr("page.title", { firm: firm.name, business: request.business_name })}</b>
                </p>
                <p className="auth-copy">
                  {request.scopes.map((s) => scopeWords(`scope.${s}`)).join(" · ")}
                </p>
                <PostForm
                  endpoint="/api/mandates"
                  fixed={{ action: "grant", request_id: request.id }}
                  submit={tr("grant")}
                  failed={failed}
                />
              </div>
            ))}
          </section>
        )}
        <section className="card">
          <span className="auth-eyebrow">{tr("activity")}</span>
          {log.length === 0 && <p className="auth-copy">{tr("activityNone")}</p>}
          <ul className="shadow-summary">
            {log.map((l, i) => {
              const [action, firmId] = l.ref.split(":");
              const what = ACTS.includes(action ?? "") ? action! : "report";
              return (
                <li key={i}>
                  {tr("activityLine", {
                    date: date(l.at),
                    person: l.person,
                    firm: names.get(firmId ?? "") ?? "-",
                    what: tr(`act.${what}`),
                  })}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}
