// /mandate/[token] — a client answers a firm's request (§7.6): who asks,
// what they may do, for how long, on which engagement letter. One button;
// no SYB account needed beforehand. Public; the token is the credential.

import type { Metadata } from "next";
import { PostForm } from "../../../components/partner/PostForm";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { requestByToken } from "../../../lib/partners/mandates";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: trFor(await requestLocale(), "mandates")("meta.title"),
    robots: { index: false },
  };
}
export const dynamic = "force-dynamic";

export default async function MandateTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "mandates");
  const scopeWords = trFor(locale, "partner");
  const open = await requestByToken(token);
  if (!open) {
    return (
      <main className="auth-stage">
        <section className="card">
          <p className="auth-copy">{tr("page.gone")}</p>
        </section>
      </main>
    );
  }
  const { request, firm } = open;
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <h1 className="auth-title">
            {tr("page.title", { firm: firm.name, business: request.business_name })}
          </h1>
          <p className="auth-copy">{tr("page.intro", { firm: firm.name })}</p>
          <ul className="shadow-summary">
            {request.scopes.map((s) => (
              <li key={s}>{scopeWords(`scope.${s}`)}</li>
            ))}
          </ul>
          <p className="auth-copy">
            {tr("page.until", { months: String(request.months), ref: request.evidence_ref })}
          </p>
          <PostForm
            endpoint={`/api/mandate/${encodeURIComponent(token)}`}
            fixed={{}}
            submit={tr("page.yes")}
            failed={tr("page.failed", { why: "{why}" })}
          />
        </section>
      </div>
    </main>
  );
}
