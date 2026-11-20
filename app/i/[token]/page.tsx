// /i/[token] — a shared idea check (TASKS-IDEAS.md), as it was made, with an
// invitation to work through your own. Public, kept out of search.
// On the card a shared check uses (app/e/[token]) since 2026-11-20.

import type { Metadata } from "next";
import Link from "next/link";
import { AuthFooter } from "../../../components/auth/Login";
import { Logo } from "../../../components/brand/Mark";
import { KeepIdea } from "../../../components/ideas/IdeaActions";
import { IdeaResultView } from "../../../components/ideas/IdeaResultView";
import { freshLocal, ideaByToken } from "../../../lib/ideas/check";
import { pickerContext, requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../auth-v2.css";
import "../../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ideas")("meta.title"), robots: { index: false } };
}
export const dynamic = "force-dynamic";

export default async function SharedIdeaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const [found, picker] = await Promise.all([ideaByToken(token), pickerContext()]);
  const shared = found ? { ...found, result: await freshLocal(found.result, found.answers) } : null;
  return (
    <div className="ax ax-signin ax-shared ax-dress">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card ax-card-wide">
        {shared ? (
          <>
            <p className="ax-kicker">{tr("sharedLabel")}</p>
            <IdeaResultView
              result={shared.result}
              answers={shared.answers}
              tr={tr}
              locale={locale}
            />
            {!shared.kept && shared.result.status === "worked" && <KeepIdea token={token} />}
          </>
        ) : (
          <p className="ax-copy">{tr("missing")}</p>
        )}
        <Link className="ax-btn ax-door" href="/idea">
          {tr("again")}
        </Link>
      </main>
      <AuthFooter languages={picker.data.languages} language={picker.data.language} />
    </div>
  );
}
