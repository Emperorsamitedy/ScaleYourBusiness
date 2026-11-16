// /i/[token] — a shared idea check (TASKS-IDEAS.md), as it was made, with an
// invitation to work through your own. Public, kept out of search.

import type { Metadata } from "next";
import Link from "next/link";
import { IdeaResultView } from "../../../components/ideas/IdeaResultView";
import { ideaByToken } from "../../../lib/ideas/check";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ideas")("meta.title"), robots: { index: false } };
}
export const dynamic = "force-dynamic";

export default async function SharedIdeaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const shared = await ideaByToken(token);
  return (
    <main className="auth-stage">
      <div className="statement-col">
        {shared ? (
          <>
            <span className="auth-eyebrow">{tr("sharedLabel")}</span>
            <IdeaResultView
              result={shared.result}
              answers={shared.answers}
              tr={tr}
              locale={locale}
            />
          </>
        ) : (
          <p className="auth-copy">{tr("missing")}</p>
        )}
        <section className="card">
          <Link className="act" href="/idea">
            {tr("again")}
          </Link>
        </section>
      </div>
    </main>
  );
}
