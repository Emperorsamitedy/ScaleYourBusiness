"use client";

// Guided page set-up (specs/page-setup-v1.md; TASKS-FEEDBACK.md "Guided page
// set-up"). For an owner with no Facebook Page or Instagram business account:
// what to type into the platforms' own forms, taken from the fact sheet, each
// piece with where it came from and a button that copies it; the platforms'
// own guides, in a new tab; and what the publishing connection holds once
// the owner has come back and given write access.
//
// Three rules ride with it. The owner creates and ScaleX prepares: nothing
// here creates or claims a Page. No platform password: there is no field for
// one, and the owner signs in on the platform's own site. And it is free on
// every plan: nothing here asks what the owner pays.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DerivedPiece, KitFactKey, PageKit } from "../../lib/pages/kit";
import { useCn } from "./useCn";

interface View {
  kit: PageKit;
  connected: { page: boolean; instagram: boolean };
  links: { facebook_guide: string; instagram_guide: string };
}

/** Which sentence says how a short line was made. */
const SHORT_SOURCE: Readonly<Record<DerivedPiece["formula"], string>> = {
  as_given: "src.shortAsGiven",
  first_sentence: "src.shortFirst",
  cut_at_clause: "src.shortCut",
  cut_at_word: "src.shortCut",
  handle: "src.username",
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PageSetupSection() {
  const { t } = useCn("connections.pageSetup");
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  /** The row last copied, and whether it worked: said beside its button and to a screen reader. */
  const [copied, setCopied] = useState<{ row: string; ok: boolean } | null>(null);
  /**
   * The guide is folded until asked for: most owners already have a Page, and
   * three steps of text are a lot to meet unasked. An address that names it
   * ("?guide=page", which is where Lex sends someone) arrives with it open.
   * Read once; the fold is only drawn after the kit has been fetched, so the
   * server's first paint and the browser's agree whatever the address says.
   */
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("guide") === "page",
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/page-setup");
        if (!res.ok) throw new Error("not ok");
        const data = (await res.json()) as View;
        if (live) setView(data);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return (
      <section className="cs cn-setup" aria-label={t("label")}>
        <div className="cs-body">
          <p className="cn-note">{t("failed")}</p>
        </div>
      </section>
    );
  }
  if (view === null) {
    return (
      <section className="cs cn-setup" aria-label={t("label")}>
        <div className="cs-body">
          <p className="cn-note">{t("reading")}</p>
        </div>
      </section>
    );
  }

  const { kit, connected, links } = view;
  const title = !connected.page
    ? t("title.todo")
    : connected.instagram
      ? t("title.doneBoth")
      : t("title.done");

  /** One piece of the kit: its name, the text, where it came from, and a button that copies it. */
  const row = (key: string, label: string, value: string, source: string) => (
    <div className="cn-kit-row" key={key}>
      <dt>{label}</dt>
      <dd>
        <span className="cn-kit-value">{value}</span>
        <span className="cn-kit-src">{source}</span>
      </dd>
      <dd className="cn-kit-act">
        <button
          type="button"
          className="ghost"
          aria-label={t("copyWhat", { what: label })}
          onClick={() => void copyText(value).then((ok) => setCopied({ row: key, ok }))}
        >
          {copied?.row === key && copied.ok ? t("copied") : t("copy")}
        </button>
      </dd>
    </div>
  );

  const guide = (
    <>
      <ol className="cn-setup-steps">
        <li>
          <h3 className="cn-setup-step">{t("step1.title")}</h3>
          <p className="cn-note">{t("step1.lede")}</p>
          <dl className="cn-kit">
            {kit.name && row("name", t("row.name"), kit.name.value, t("src.name"))}
            {kit.category_hint && (
              <div className="cn-kit-row">
                <dt>{t("row.category")}</dt>
                <dd>
                  <span className="cn-kit-value">
                    {t("row.categoryHint", { type: kit.category_hint.value })}
                  </span>
                  <span className="cn-kit-src">{t("src.type")}</span>
                </dd>
              </div>
            )}
            {kit.short_line &&
              row(
                "short",
                t("row.short"),
                kit.short_line.value,
                t(SHORT_SOURCE[kit.short_line.formula]),
              )}
            {kit.about &&
              kit.about.value !== kit.short_line?.value &&
              row("about", t("row.about"), kit.about.value, t("src.about"))}
            {kit.website && row("website", t("row.website"), kit.website.value, t("src.website"))}
          </dl>
          <p className="cn-setup-go">
            <a
              className="ghost"
              href={links.facebook_guide}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("step1.open")}
              <span className="sr-only"> {t("newTab")}</span>
            </a>
          </p>
        </li>
        <li>
          <h3 className="cn-setup-step">{t("step2.title")}</h3>
          <p className="cn-note">{t("step2.lede")}</p>
          {kit.username && (
            <dl className="cn-kit">
              {row("username", t("row.username"), kit.username.value, t("src.username"))}
            </dl>
          )}
          <p className="cn-setup-go">
            <a
              className="ghost"
              href={links.instagram_guide}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("step2.open")}
              <span className="sr-only"> {t("newTab")}</span>
            </a>
          </p>
        </li>
        <li>
          <h3 className="cn-setup-step">{t("step3.title")}</h3>
          <p className="cn-note">{t("step3.lede")}</p>
          <ul className="cn-setup-state">
            <li>
              <span className={`word ${connected.page ? "ok" : "low"}`}>
                {connected.page ? t("state.pageYes") : t("state.pageNo")}
              </span>
            </li>
            <li>
              <span className={`word ${connected.instagram ? "ok" : "low"}`}>
                {connected.instagram ? t("state.instagramYes") : t("state.instagramNo")}
              </span>
            </li>
          </ul>
        </li>
      </ol>

      {kit.gaps.length > 0 && (
        <div className="cn-setup-gaps">
          <p className="cn-sub">{t("gaps.title")}</p>
          <ul>
            {kit.gaps.map((g) => (
              <li key={g.key}>
                {t(`gap.${g.key satisfies KitFactKey}`)}{" "}
                <Link href={`/intake?ask=${encodeURIComponent(g.question)}`}>
                  {t("gaps.answer")}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="cn-note">
        <Link href="/profile">{t("change")}</Link>
      </p>
      {/* One polite line for whoever cannot see the button's word change. */}
      <p className="sr-only" role="status">
        {copied === null ? "" : copied.ok ? t("copied") : t("copyFailed")}
      </p>
      {copied !== null && !copied.ok && <p className="cn-error">{t("copyFailed")}</p>}
    </>
  );

  return (
    <section className="cs cn-setup" aria-labelledby="cn-setup-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{t("label")}</p>
          <h2 className="cs-title" id="cn-setup-title">
            {title}
          </h2>
        </div>
      </header>
      <div className="cs-body cn-setup-body">
        <p className="cn-setup-lede">{t("lede")}</p>
        <details
          className="fold cn-setup-fold"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary>{t("show")}</summary>
          <div className="fold-body">{guide}</div>
        </details>
      </div>
      <footer className="cs-foot">{t("foot")}</footer>
    </section>
  );
}
