// /growth — the growth studio (v1 spec §10): the brand voice as words the
// owner reads and corrects (§10.3), what the business's own figures say to
// promote and the briefs that cite them (§10.1–§10.2), the asset library
// with each asset's rights (§10.4), what is running low, and the identity
// releases a video of a real person needs (Art. 50(4)).

import type { Metadata } from "next";
import { desc, eq, inArray } from "drizzle-orm";
import { AssetUpload } from "../../components/growth/AssetUpload";
import { PostForm } from "../../components/partner/PostForm";
import { db } from "../../db";
import { creativeBriefs, figures, identityReleases } from "../../db/schema";
import { resolveAccess } from "../../lib/auth/access";
import { detectOpportunities } from "../../lib/growth/brief";
import { currentVoice, libraryOf, runningLow } from "../../lib/growth/library";
import { dayMonthYear } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "growth")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function GrowthPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "growth");
  const access = await resolveAccess();
  if (!access) {
    return (
      <main className="auth-stage">
        <section className="card">
          <p className="auth-copy">{tr("intro")}</p>
        </section>
      </main>
    );
  }
  const id = access.profile_id;
  const [voice, opps, briefs, library, low, releases] = await Promise.all([
    currentVoice(id),
    detectOpportunities(id),
    db
      .select()
      .from(creativeBriefs)
      .where(eq(creativeBriefs.profile_id, id))
      .orderBy(desc(creativeBriefs.created_at))
      .limit(10),
    libraryOf(id),
    runningLow(id),
    db
      .select()
      .from(identityReleases)
      .where(eq(identityReleases.profile_id, id))
      .orderBy(desc(identityReleases.created_at)),
  ]);
  const cited = [...new Set(briefs.flatMap((b) => b.evidence))];
  const keys = new Map(
    (cited.length
      ? await db
          .select({ id: figures.id, key: figures.key })
          .from(figures)
          .where(inArray(figures.id, cited))
      : []
    ).map((f) => [f.id, f.key]),
  );
  const failed = tr("failed", { why: "{why}" });
  const live = releases.filter((r) => r.revoked_at === null);
  return (
    <main className="auth-stage">
      <div className="statement-col">
        <section className="card">
          <span className="auth-eyebrow">{tr("kicker")}</span>
          <p className="auth-copy">{tr("intro")}</p>
        </section>

        <section className="card">
          <span className="auth-eyebrow">{tr("voice.title")}</span>
          {!voice ? (
            <>
              <p className="auth-copy">{tr("voice.none")}</p>
              <PostForm
                endpoint="/api/growth"
                fixed={{ action: "build_voice" }}
                submit={tr("voice.build")}
                failed={failed}
              />
            </>
          ) : (
            <>
              <p className="auth-copy growth-voice">{voice.description}</p>
              <p className="auth-copy">
                {voice.status === "confirmed" ? tr("voice.confirmed") : tr("voice.draft")}
              </p>
              {voice.status !== "confirmed" && (
                <PostForm
                  endpoint="/api/growth"
                  fixed={{ action: "confirm_voice" }}
                  submit={tr("voice.confirm")}
                  failed={failed}
                />
              )}
              <PostForm
                endpoint="/api/growth"
                fixed={{ action: "edit_voice" }}
                fields={[
                  {
                    name: "description",
                    label: tr("voice.edit"),
                    kind: "textarea",
                    initial: voice.description,
                  },
                ]}
                submit={tr("voice.save")}
                failed={failed}
                className="ghost"
              />
            </>
          )}
        </section>

        <section className="card">
          <span className="auth-eyebrow">{tr("opps.title")}</span>
          {opps.length === 0 && <p className="auth-copy">{tr("opps.none")}</p>}
          {opps.map((o) => (
            <div key={o.trigger} className="mandate-row">
              <p className="auth-copy">
                <b>{tr(`trigger.${o.trigger}`)}</b> ·{" "}
                {tr("opps.figures", { count: String(o.figure_ids.length) })}
              </p>
              <PostForm
                endpoint="/api/growth"
                fixed={{ action: "open_brief", trigger: o.trigger }}
                fields={[
                  { name: "subject", label: tr("opps.subject"), kind: "text" },
                  { name: "angle", label: tr("opps.angle"), kind: "text" },
                  { name: "assets", label: tr("opps.assets"), kind: "text" },
                ]}
                submit={tr("opps.open")}
                failed={failed}
                className="ghost"
              />
            </div>
          ))}
        </section>

        <section className="card">
          <span className="auth-eyebrow">{tr("briefs.title")}</span>
          {briefs.length === 0 && <p className="auth-copy">{tr("briefs.none")}</p>}
          {briefs.map((b) => (
            <p key={b.id} className="auth-copy">
              <b>{b.subject ?? b.campaign}</b>
              {b.angle ? ` · ${b.angle}` : ""}
              <br />
              {b.evidence.length > 0
                ? tr("briefs.evidence", {
                    keys: b.evidence.map((e) => keys.get(e) ?? "—").join(", "),
                  })
                : tr("briefs.noEvidence")}
            </p>
          ))}
        </section>

        {low.length > 0 && (
          <section className="card">
            <span className="auth-eyebrow">{tr("low.title")}</span>
            <ul className="shadow-summary">
              {low.map((l, i) => (
                <li key={i}>
                  {tr("low.line", {
                    description: l.description,
                    have: String(l.have),
                    need: String(l.need),
                  })}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card">
          <span className="auth-eyebrow">{tr("assets.title")}</span>
          {library.length === 0 && <p className="auth-copy">{tr("assets.none")}</p>}
          <ul className="shadow-summary">
            {library.map(({ asset: a, uses }) => (
              <li key={a.id}>
                {tr("assets.line", {
                  description: a.description,
                  shotBy: a.shot_by,
                  uses: String(uses),
                })}
                {a.person_appears &&
                  ` · ${tr("assets.person")} · ${a.identity_release_id ? tr("assets.released") : tr("assets.noRelease")}`}
              </li>
            ))}
          </ul>
          <AssetUpload
            releases={live.map((r) => ({ id: r.id, person: r.person }))}
            words={{
              file: tr("assets.file"),
              description: tr("assets.description"),
              shotBy: tr("assets.shotBy"),
              personAppears: tr("assets.personAppears"),
              release: tr("assets.release"),
              none: tr("assets.noneRelease"),
              add: tr("assets.add"),
              failed,
            }}
          />
        </section>

        <section className="card">
          <span className="auth-eyebrow">{tr("releases.title")}</span>
          <p className="auth-copy">{tr("releases.intro")}</p>
          {releases.length === 0 && <p className="auth-copy">{tr("releases.none")}</p>}
          {releases.map((r) => (
            <div key={r.id} className="mandate-row">
              <p className="auth-copy">
                {tr("releases.line", {
                  person: r.person,
                  ref: r.evidence_ref,
                  date: dayMonthYear(r.signed_at.slice(0, 10), locale),
                })}
                {r.revoked_at && ` · ${tr("releases.revoked")}`}
              </p>
              {!r.revoked_at && (
                <PostForm
                  endpoint="/api/growth"
                  fixed={{ action: "revoke_release", release_id: r.id }}
                  submit={tr("releases.revoke")}
                  failed={failed}
                  className="ghost quiet"
                />
              )}
            </div>
          ))}
          <PostForm
            endpoint="/api/growth"
            fixed={{ action: "add_release" }}
            fields={[
              { name: "person", label: tr("releases.person"), kind: "text" },
              { name: "evidence_ref", label: tr("releases.ref"), kind: "text" },
            ]}
            submit={tr("releases.add")}
            failed={failed}
            className="ghost"
          />
        </section>
      </div>
    </main>
  );
}
