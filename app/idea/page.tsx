// /idea — the idea check (TASKS-IDEAS.md): a business that doesn't exist
// yet, its own numbers worked through beside Eurostat's. No account, the
// result on the same page. Public.

import type { Metadata } from "next";
import { IdeaForm } from "../../components/ideas/IdeaForm";
import { ideaOptions } from "../../lib/ideas/options";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ideas")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function IdeaPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const options = await ideaOptions(locale);
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <h1 className="auth-title">{tr("title")}</h1>
          <p className="auth-copy">{tr("intro")}</p>
        </section>
        <IdeaForm {...options} />
      </div>
    </main>
  );
}
