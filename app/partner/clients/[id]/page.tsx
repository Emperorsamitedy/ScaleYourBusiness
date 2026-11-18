// /partner/clients/[id] — one client in the Partner Console (§7.2's row
// actions): the diagnosis as SYB wrote it, the firm's own comment on each
// section (§7.3, kept apart and never touched by a re-run), the proposals
// waiting (with approve_actions), a nudge to connect something (with
// manage_connectors), and the co-branded report (with receive_reports).
// No live mandate: "not found", like any business the partner can't see.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PostForm } from "../../../../components/partner/PostForm";
import { requestLocale } from "../../../../lib/i18n/server";
import { trFor } from "../../../../lib/i18n/server-tr";
import { PartnerAccessError } from "../../../../lib/partners/access";
import { COMMENTARY_SECTIONS, clientView } from "../../../../lib/partners/actions";
import { partnerSession } from "../../../../lib/partners/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "partner")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await requestLocale();
  const tr = trFor(locale, "partner");
  const session = await partnerSession();
  if (!session || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const view = await clientView({ userId: session.user_id, profileId: id }).catch((e: unknown) => {
    if (e instanceof PartnerAccessError) return null;
    throw e;
  });
  if (!view) notFound();
  const failed = tr("failed", { why: "{why}" });
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">
            {tr("kicker")} · {view.firm.name}
          </span>
          <h1 className="auth-title">{view.business ?? tr("unnamed")}</h1>
          {view.report ? (
            <p className="auth-copy">
              {tr("report.version", {
                version: String(view.report.version),
                grade: view.report.grade,
              })}
            </p>
          ) : (
            <p className="auth-copy">{tr("client.noReport")}</p>
          )}
          {view.scopes.reports && (
            <p className="auth-copy">
              <Link href={`/partner/clients/${id}/report`}>{tr("client.report")}</Link>
            </p>
          )}
          <p className="auth-copy">
            <Link href="/partner">{tr("client.back")}</Link>
          </p>
        </section>
        {COMMENTARY_SECTIONS.map((section) => (
          <section key={section} className="card">
            <span className="auth-eyebrow">{tr(`section.${section}`)}</span>
            {section === "findings" &&
              view.report?.findings.map((f) => (
                <p key={f.title} className="auth-copy">
                  <b>{f.title}</b>: {f.detail}
                </p>
              ))}
            {section === "recommendations" &&
              view.report?.recommendations.map((r) => (
                <p key={r.title} className="auth-copy">
                  <b>{r.title}</b>
                </p>
              ))}
            <PostForm
              endpoint="/api/partner"
              fixed={{ action: "commentary", client: id, section }}
              fields={[
                {
                  name: "body",
                  label: tr("client.commentary"),
                  kind: "textarea",
                  initial: view.commentary[section] ?? "",
                },
              ]}
              submit={tr("client.save")}
              done={tr("client.saved")}
              failed={failed}
              className="ghost"
            />
          </section>
        ))}
        {view.scopes.approve && (
          <section className="card">
            <span className="auth-eyebrow">{tr("client.awaiting")}</span>
            {view.waiting.map((w) => (
              <div key={w.id} className="auth-copy">
                <p>{w.summary}</p>
                <PostForm
                  endpoint="/api/partner"
                  fixed={{ action: "approve", client: id, proposal_id: w.id }}
                  submit={tr("client.approve")}
                  failed={failed}
                />
              </div>
            ))}
          </section>
        )}
        {view.scopes.connectors && (
          <section className="card">
            <span className="auth-eyebrow">{tr("client.nudge")}</span>
            <PostForm
              endpoint="/api/partner"
              fixed={{ action: "nudge", client: id }}
              fields={[{ name: "what", label: tr("client.nudgeWhat"), kind: "text" }]}
              submit={tr("client.nudgeSend")}
              done={tr("client.nudged")}
              failed={failed}
              className="ghost"
            />
          </section>
        )}
      </div>
    </main>
  );
}
