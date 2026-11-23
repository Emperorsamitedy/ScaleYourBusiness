// /growth — the growth studio (v1 spec §10), since 2026-11-23 the second tab
// of Grow's "Ads and videos" (the creative studio, /studio, is the first):
// the brand voice as words the
// owner reads and corrects (§10.3), what the business's own figures say to
// promote and the briefs that cite them (§10.1–§10.2), the asset library
// with each asset's rights (§10.4), what is running low, and the identity
// releases a video of a real person needs (Art. 50(4)).

import type { Metadata } from "next";
import { desc, eq, inArray } from "drizzle-orm";
import { AdsTabs } from "../../components/grow/AdsTabs";
import { AssetUpload } from "../../components/growth/AssetUpload";
import { PostForm } from "../../components/partner/PostForm";
import { Fold } from "../../components/sheet/Fold";
import { PageHead, SheetCard } from "../../components/sheet/PageHead";
import { db } from "../../db";
import { creativeBriefs, figures, identityReleases } from "../../db/schema";
import { resolveAccess } from "../../lib/auth/access";
import { detectOpportunities } from "../../lib/growth/brief";
import { currentVoice, libraryOf, runningLow } from "../../lib/growth/library";
import { dayMonthYear } from "../../lib/i18n/format";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import "../plain.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: trFor(await requestLocale(), "growth")("meta.title") };
}
export const dynamic = "force-dynamic";

export default async function GrowthPage() {
  const locale = await requestLocale();
  const tr = trFor(locale, "growth");
  const nav = trFor(locale, "nav");
  // Where this screen sits, in the menu's own words: a tab of "Ads and videos", in Grow.
  const kicker = `${nav("group.grow")} · ${nav("item.studio")}`;
  const title = nav("item.studio");
  const access = await resolveAccess();
  if (!access) {
    return (
      <main className="screen pg">
        <PageHead kicker={kicker} title={title}>
          <p className="ph-lede">{tr("intro")}</p>
        </PageHead>
        <AdsTabs at="yours" />
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
    <main className="screen pg">
      <PageHead kicker={kicker} title={title}>
        <p className="ph-lede">{tr("intro")}</p>
      </PageHead>
      <AdsTabs at="yours" />
      <div className="pg-cols">
        <div className="pg-stack">
          <SheetCard title={tr("voice.title")}>
            {!voice ? (
              <>
                <p>{tr("voice.none")}</p>
                <PostForm
                  endpoint="/api/growth"
                  fixed={{ action: "build_voice" }}
                  submit={tr("voice.build")}
                  failed={failed}
                  className="act solid"
                />
              </>
            ) : (
              <>
                <p className="growth-voice">{voice.description}</p>
                <p className="pg-quiet">
                  {voice.status === "confirmed" ? tr("voice.confirmed") : tr("voice.draft")}
                </p>
                {voice.status !== "confirmed" && (
                  <PostForm
                    endpoint="/api/growth"
                    fixed={{ action: "confirm_voice" }}
                    submit={tr("voice.confirm")}
                    failed={failed}
                    className="act solid"
                  />
                )}
                {/* Correcting it is a form of its own: folded until it is wanted. */}
                <Fold summary={tr("voice.edit")}>
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
                  />
                </Fold>
              </>
            )}
          </SheetCard>

          <SheetCard title={tr("opps.title")}>
            {opps.length === 0 && <p>{tr("opps.none")}</p>}
            {opps.map((o) => (
              <div key={o.trigger} className="pg-row">
                <p>
                  <b>{tr(`trigger.${o.trigger}`)}</b> ·{" "}
                  {tr("opps.figures", { count: String(o.figure_ids.length) })}
                </p>
                <Fold summary={tr("opps.open")}>
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
                  />
                </Fold>
              </div>
            ))}
          </SheetCard>

          <SheetCard title={tr("briefs.title")}>
            {briefs.length === 0 && <p>{tr("briefs.none")}</p>}
            {briefs.length > 0 && (
              <ul className="pg-lines">
                {briefs.map((b) => (
                  <li key={b.id}>
                    <b>{b.subject ?? b.campaign}</b>
                    {b.angle ? ` · ${b.angle}` : ""}
                    <br />
                    <span className="pg-quiet">
                      {b.evidence.length > 0
                        ? tr("briefs.evidence", {
                            keys: b.evidence.map((e) => keys.get(e) ?? "-").join(", "),
                          })
                        : tr("briefs.noEvidence")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SheetCard>

          {low.length > 0 && (
            <SheetCard title={tr("low.title")}>
              <ul className="pg-lines">
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
            </SheetCard>
          )}
        </div>

        <div className="pg-stack">
          <SheetCard title={tr("assets.title")}>
            {library.length === 0 && <p className="pg-quiet">{tr("assets.none")}</p>}
            {library.length > 0 && (
              <ul className="pg-lines">
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
            )}
            <Fold summary={tr("assets.add")}>
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
            </Fold>
          </SheetCard>

          <SheetCard title={tr("releases.title")}>
            <p>{tr("releases.intro")}</p>
            {releases.length === 0 && <p className="pg-quiet">{tr("releases.none")}</p>}
            {releases.map((r) => (
              <div key={r.id} className="pg-row">
                <p>
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
                    className="act"
                  />
                )}
              </div>
            ))}
            <Fold summary={tr("releases.add")}>
              <PostForm
                endpoint="/api/growth"
                fixed={{ action: "add_release" }}
                fields={[
                  { name: "person", label: tr("releases.person"), kind: "text" },
                  { name: "evidence_ref", label: tr("releases.ref"), kind: "text" },
                ]}
                submit={tr("releases.add")}
                failed={failed}
              />
            </Fold>
          </SheetCard>
        </div>
      </div>
    </main>
  );
}
