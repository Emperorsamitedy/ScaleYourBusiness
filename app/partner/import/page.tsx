// /partner/import — §7.6's bulk onboarding: one CSV of clients, one
// engagement-letter reference and one scope list; each client is asked by
// email, in their own language.

import type { Metadata } from "next";
import Link from "next/link";
import { MANDATE_SCOPES } from "../../../db/schema";
import { PostForm } from "../../../components/partner/PostForm";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import { DEFAULT_MONTHS } from "../../../lib/partners/mandates";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "partner")("import.title") };
}
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "partner");
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <h1 className="auth-title">{tr("import.title")}</h1>
          <p className="auth-copy">{tr("import.intro")}</p>
          <PostForm
            endpoint="/api/partner"
            fixed={{ action: "import", default_language: locale }}
            fields={[
              {
                name: "csv",
                label: tr("import.csv"),
                kind: "textarea",
                initial: "Business,Email,Country,Language\n",
              },
              { name: "evidence_ref", label: tr("import.evidence"), kind: "text" },
              {
                name: "scopes",
                label: tr("import.scopes"),
                kind: "checkboxes",
                initial: ["read_diagnosis", "receive_reports"],
                options: MANDATE_SCOPES.map((s) => ({ value: s, label: tr(`scope.${s}`) })),
              },
              {
                name: "months",
                label: tr("import.months"),
                kind: "number",
                initial: String(DEFAULT_MONTHS),
              },
            ]}
            submit={tr("import.submit")}
            done={tr("import.done", {
              requested: "{requested}",
              skipped: "{skipped}",
              sent: "{sent}",
              notConfigured: "{notConfigured}",
              failed: "{failed}",
            })}
            failed={tr("failed", { why: "{why}" })}
          />
          <p className="auth-copy">
            <Link href="/partner">{tr("client.back")}</Link>
          </p>
        </section>
      </div>
    </main>
  );
}
