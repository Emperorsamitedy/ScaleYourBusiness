// /e/[token] — a shared free-entry result (v1 spec §8.2, §5.6): the result
// as it was made, with an invitation to check your own business. Public;
// the invitation carries the token, so the referral chain is kept.

import type { Metadata } from "next";
import Link from "next/link";
import { EntryResultView } from "../../../components/entry/EntryResultView";
import { entryByToken } from "../../../lib/entry/one-number";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "entry")("meta.title"), robots: { index: false } };
}
export const dynamic = "force-dynamic";

export default async function SharedEntryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "entry");
  const shared = await entryByToken(token);
  return (
    <main className="auth-stage">
      <div className="statement-col">
        {shared ? (
          <>
            <span className="auth-eyebrow">{tr("sharedLabel")}</span>
            <EntryResultView result={shared.result} tr={tr} locale={locale} />
          </>
        ) : (
          <p className="auth-copy">{tr("missing")}</p>
        )}
        <section className="card">
          <p className="auth-copy">{tr("invite")}</p>
          <Link className="act" href={`/check?ref=${encodeURIComponent(token)}`}>
            {tr("submit")}
          </Link>
        </section>
      </div>
    </main>
  );
}
