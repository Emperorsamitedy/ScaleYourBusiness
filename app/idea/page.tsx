// /idea — the idea check (TASKS-IDEAS.md): a business that doesn't exist
// yet, its own numbers worked through beside Eurostat's. No account, the
// result on the same page. Public.
//
// Dressed as the free check since 2026-11-20 (the owner: "there's also this
// page and what follows it"): the wordmark, the questions on paper and the
// reel beside them. It had kept the look from before the entrance was
// redesigned: three square cards on the desk with no wordmark at all.

import type { Metadata } from "next";
import Link from "next/link";
import { AuthReel } from "../../components/auth/AuthReel";
import { AuthFooter } from "../../components/auth/Login";
import { Logo } from "../../components/brand/Mark";
import { IdeaForm } from "../../components/ideas/IdeaForm";
import { ideaOptions } from "../../lib/ideas/options";
import { pickerContext, requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../auth-v2.css";
import "../ideas.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "ideas")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function IdeaPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "ideas");
  const [options, picker] = await Promise.all([ideaOptions(locale), pickerContext()]);
  return (
    <div className="ax ax-signup ax-check ax-dress">
      <section className="ax-col">
        <div className="ax-col-in">
          <Link href="/" className="ax-logo">
            <Logo />
          </Link>
          <main className="ax-signup-main">
            <p className="ax-kicker">{tr("kicker")}</p>
            <h1 className="ax-title ax-title-lg">{tr("title")}</h1>
            <p className="ax-copy">{tr("intro")}</p>
            <IdeaForm {...options} />
          </main>
          <AuthFooter languages={picker.data.languages} language={picker.data.language} />
        </div>
      </section>
      <AuthReel scene="glint" />
    </div>
  );
}
