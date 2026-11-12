// /settings/data — the owner asks for this business to be erased (v1 spec §9.4).

import type { Metadata } from "next";
import { PostForm } from "../../../components/partner/PostForm";
import { resolveAccess } from "../../../lib/auth/access";
import { erasureOf } from "../../../lib/compliance/erasure";
import { dayMonthYear } from "../../../lib/i18n/format";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "erasure")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function DataPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "erasure");
  const access = await resolveAccess();
  const r = access ? await erasureOf(access.profile_id) : null;
  return (
    <main className="auth-stage">
      <section className="card">
        <span className="auth-eyebrow">{tr("kicker")}</span>
        <p className="auth-copy">{tr("body")}</p>
        {r ? (
          <p className="auth-copy">
            <b>{tr("requested", { date: dayMonthYear(r.requested_at.slice(0, 10), locale) })}</b>
          </p>
        ) : access ? (
          <PostForm
            endpoint="/api/business/erasure"
            fixed={{}}
            submit={tr("ask")}
            failed={tr("failed", { why: "{why}" })}
            className="ghost"
          />
        ) : null}
      </section>
    </main>
  );
}
