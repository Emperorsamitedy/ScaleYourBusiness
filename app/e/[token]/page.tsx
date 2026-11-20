// /e/[token] — a shared free-entry result (v1 spec §8.2, §5.6): the result
// as it was made, with an invitation to check your own business. Public;
// the invitation carries the token, so the referral chain is kept.
//
// Dressed as the sign-in page since 2026-11-17 (the owner): one card on
// Ink, the same door as /check, /login and /signup.

import type { Metadata } from "next";
import Link from "next/link";
import { AuthFooter } from "../../../components/auth/Login";
import { Logo } from "../../../components/brand/Mark";
import { EntryResultView } from "../../../components/entry/EntryResultView";
import { entryByToken } from "../../../lib/entry/one-number";
import { pickerContext, requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../auth-v2.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "entry")("meta.title"), robots: { index: false } };
}
export const dynamic = "force-dynamic";

export default async function SharedEntryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "entry");
  const [shared, picker] = await Promise.all([entryByToken(token), pickerContext()]);
  return (
    <div className="ax ax-signin ax-shared">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card ax-card-wide">
        {shared ? (
          <>
            <p className="ax-kicker">{tr("sharedLabel")}</p>
            <EntryResultView result={shared.result} tr={tr} locale={locale} />
          </>
        ) : (
          <p className="ax-copy">{tr("missing")}</p>
        )}
        <p className="ax-copy">{tr("invite")}</p>
        <Link className="ax-btn ax-primary" href={`/check?ref=${encodeURIComponent(token)}`}>
          {tr("submit")}
        </Link>
      </main>
      <AuthFooter languages={picker.data.languages} language={picker.data.language} />
    </div>
  );
}
