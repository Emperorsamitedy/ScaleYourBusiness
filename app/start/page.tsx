// /start — Getting started (ux-spec §7.0, the owner, 2026-11-28: "what's
// gonna be there at the front… the flow… looks like broken to me").
//
// Until a business has its first diagnosis, Home sends its owner here
// (app/home/page.tsx), so this is the first screen after a sign-up. Five
// steps in one order, each done or not by lib/journey; one "Continue" opens
// the first step not done. The language step is answered on this page; the
// others open the screen that does them, which ends back on Home and so here.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FirstStep } from "../../components/locale/LocalePicker";
import { AUTH_COOKIE } from "../../lib/auth/access";
import { currentSession } from "../../lib/auth/service";
import { profileKind } from "../../lib/ideas/keep";
import { pickerContext } from "../../lib/i18n/server";
import { ENTRY_COOKIE, isEntryToken } from "../../lib/journey/entry-wires";
import { journeyFor } from "../../lib/journey/read";
import { INTERVIEW_WITH_LEX, JOURNEY_STEPS, STEP_HREF, statusOf } from "../../lib/journey/stage";
import "../auth-v2.css";
import "../start.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("journey.meta");
  return { title: t("title") };
}

export const dynamic = "force-dynamic";

export default async function StartPage() {
  const picker = await pickerContext();
  const access = picker.access;
  if (!access) {
    const store = await cookies();
    const session = await currentSession(store.get(AUTH_COOKIE)?.value);
    redirect(session ? "/login/choose" : "/login");
  }
  if ((await profileKind(access.profile_id)) === "idea") redirect("/idea/mine");

  // Came from the free check's "Save this": the result is carried into this
  // business once and then forgotten (app/api/entry/carry), and the owner
  // comes back here. Only a route can clear the cookie, hence the hop.
  if (access.session && isEntryToken((await cookies()).get(ENTRY_COOKIE)?.value)) {
    redirect("/api/entry/carry");
  }
  const journey = await journeyFor(access.account_id, access.profile_id);

  const [t, tNav] = await Promise.all([getTranslations("journey"), getTranslations("nav")]);
  const next = journey.next;
  const total = JOURNEY_STEPS.length;
  // The interview's own way in is chosen on its card; Continue takes Lex, the default.
  const continueHref =
    next === null ? "/home" : next === "interview" ? INTERVIEW_WITH_LEX : STEP_HREF[next];

  return (
    <main className="screen start" aria-labelledby="gs-title">
      <header className="gs-head">
        <p className="gs-kick">{t("meta.title")}</p>
        <h1 className="gs-title" id="gs-title">
          {t("title")}
        </h1>
        <p className="gs-lede">{t("lede")}</p>
        <div className="gs-progress">
          <span
            className="gs-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={journey.done}
            aria-label={t("progress", { done: journey.done, total })}
          >
            {journey.steps.map((s) => (
              <i key={s.step} className={s.done ? "on" : undefined} />
            ))}
          </span>
          <span className="gs-count">{t("progress", { done: journey.done, total })}</span>
        </div>
        {journey.set_up ? (
          <p className="gs-ready">
            <span>{t("setUp", { home: tNav("item.home") })}</span>
            <Link className="gs-btn gs-primary" href="/home">
              {tNav("item.home")}
            </Link>
          </p>
        ) : (
          next !== "language" && (
            <p className="gs-go">
              <Link className="gs-btn gs-primary" href={continueHref}>
                {t("continue")}
              </Link>
            </p>
          )
        )}
      </header>

      <ol className="gs-steps">
        {JOURNEY_STEPS.map((step, i) => {
          const status = statusOf(journey, step);
          const open = status === "next" || (status === "later" && step !== "language");
          return (
            <li
              key={step}
              id={step}
              className={`gs-step is-${status}`}
              aria-current={status === "next" ? "step" : undefined}
            >
              <span className="gs-no" aria-hidden="true">
                {i + 1}
              </span>
              <div className="gs-body">
                <p className="gs-meta">
                  <span>{t("stepNo", { n: i + 1 })}</span>
                  <span className={`gs-flag is-${status}`}>{t(`status.${status}`)}</span>
                </p>
                <h2 className="gs-name">{t(`step.${step}.title`)}</h2>
                <p className="gs-line">
                  {step === "interview" && journey.interview_started
                    ? t("step.interview.started")
                    : t(`step.${step}.line`)}
                </p>
                {step === "language" && status === "next" && (
                  <div className="ax gs-lang">
                    <FirstStep data={picker.data} />
                  </div>
                )}
                {step === "interview" && open && (
                  <>
                    <p className="gs-acts">
                      <Link className="gs-btn gs-primary" href={INTERVIEW_WITH_LEX}>
                        {t("step.interview.withLex")}
                      </Link>
                      <Link className="gs-btn" href={STEP_HREF.interview}>
                        {t("step.interview.withForm")}
                      </Link>
                    </p>
                    <p className="gs-note">{t("step.interview.both")}</p>
                  </>
                )}
                {step !== "language" && step !== "interview" && open && (
                  <p className="gs-acts">
                    <Link
                      className={status === "next" ? "gs-btn gs-primary" : "gs-btn"}
                      href={STEP_HREF[step]}
                    >
                      {t(`step.${step}.open`)}
                    </Link>
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </main>
  );
}
