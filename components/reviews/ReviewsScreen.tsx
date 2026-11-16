"use client";

// Customers · Reviews — idea 45, on the sheet system (app/sheet.css).
// The head is the month's main fact: how many reviews were 3 stars or
// fewer, of how many. Then every review on file, newest first, with its
// platform, its stars in words, when, the words, and "Suggest a reply";
// the forwarding address with plain setup steps; and a "Paste a review"
// form. A suggestion is text to edit; under a review read from Google, with
// a connection consented to replies (I-45a lifted 2026-11-16), "Approve and
// post on Google" approves those exact words and ScaleX posts them through
// the engine. Anywhere else it stays text to copy, with a link to the review.
//
// L-3b (TASKS-LANGUAGES.md): the screen's own words are the "reviews"
// catalogue; dates and counts in the reader's locale. A review's words,
// the reviewer's name and a suggested reply are content, shown as they are.

import "../../app/reviews.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ReviewItem, ReviewsView } from "../../lib/review-desk/view";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useRole } from "../auth/RoleContext";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import {
  GOOGLE_NEED_KEYS,
  MAX_STARS,
  POOR_STARS,
  setupSteps,
  asideLine,
  gmailConfirmationLine,
  dayLabel,
  monthName,
  readNote,
  reviewsHeadline,
  starsWords,
  thisMonth,
} from "./reviews-view";

type Post = (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useTr("reviews");
  return (
    <main className="screen rv-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
      <Fold className="rv-foot on-desk">
        <p>{tr("foot")}</p>
      </Fold>
    </main>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function ReviewEntry({
  r,
  today,
  post,
  googleConnected,
}: {
  r: ReviewItem;
  today: string;
  post: Post;
  googleConnected: boolean;
}) {
  const { tr, locale } = useTr("reviews");
  const [draft, setDraft] = useState(r.draft ?? "");
  const [busy, setBusy] = useState<"draft" | "remove" | "post" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  // Idea 52: a viewer reads the reviews; answering them is an owner's or a manager's.
  const answerWhy = useRole().why("reviews.answer");
  useEffect(() => setDraft(r.draft ?? ""), [r.draft]);
  const unread = r.stars === null && r.text === null;
  const read = readNote(r, tr);
  const platformLabel = r.platform === "other" ? tr("platform.other") : r.platform_label;

  const suggest = async () => {
    setBusy("draft");
    setNote(null);
    const out = await post({ action: "draft", id: r.id });
    if (out && out.drafted !== true) {
      setNote(typeof out.message === "string" ? out.message : tr("entry.failed"));
    }
    setBusy(null);
  };
  const remove = async () => {
    setBusy("remove");
    await post({ action: "remove", id: r.id });
    setBusy(null);
  };
  const postOnGoogle = async () => {
    setBusy("post");
    setNote(null);
    const out = await post({ action: "post", id: r.id, text: draft });
    if (out && out.result === "refused" && typeof out.message === "string") setNote(out.message);
    setBusy(null);
  };
  const waiting = r.post.state === "waiting";
  const site = r.platform === "other" ? tr("entry.theSite") : r.platform_label;

  return (
    <li className={`rv-item${r.worth_knowing ? " rv-worth" : ""}`}>
      <p className="rv-line">
        <span className="rv-platform">{platformLabel}</span>
        <span>{starsWords(r.stars, tr, locale)}</span>
        <span>{dayLabel(r.reviewed_at, today, locale)}</span>
        {r.worth_knowing && <span className="word drift">{tr("entry.worthKnowing")}</span>}
      </p>
      {r.reviewer && <p className="rv-who">{r.reviewer}</p>}
      {r.text ? (
        <p className="rv-text">{r.text}</p>
      ) : (
        !unread && <p className="rv-text rv-quiet">{tr("entry.noWords")}</p>
      )}
      {read && <p className="rv-fine">{read}</p>}

      {r.draft && (
        <div className="rv-draft">
          <label className="cs-label" htmlFor={`draft-${r.id}`}>
            {tr("entry.draftLabel")}
          </label>
          <textarea
            id={`draft-${r.id}`}
            className="rv-textarea"
            rows={5}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCopied(false);
            }}
          />
        </div>
      )}

      <div className="rv-actions">
        {r.draft && r.post.can ? (
          <button
            type="button"
            className="act solid"
            disabled={draft.trim() === "" || busy !== null || waiting || answerWhy !== null}
            onClick={() => void postOnGoogle()}
          >
            {busy === "post" ? tr("entry.posting") : tr("entry.postGoogle")}
          </button>
        ) : null}
        {r.draft ? (
          <button
            type="button"
            className={r.post.can ? "act" : "act solid"}
            disabled={draft.trim() === ""}
            onClick={() => void copyText(draft).then(setCopied)}
          >
            {copied ? tr("entry.copied") : tr("entry.copyReply")}
          </button>
        ) : null}
        {!unread && (
          <button
            type="button"
            className="act"
            disabled={busy !== null || r.drafts_left === 0 || answerWhy !== null}
            onClick={() => void suggest()}
          >
            {busy === "draft"
              ? tr("entry.drafting")
              : r.draft
                ? tr("entry.suggestAnother")
                : tr("entry.suggest")}
          </button>
        )}
        {r.link && (
          <a className="rv-link" href={r.link} target="_blank" rel="noopener noreferrer">
            {tr("entry.openOn", {
              site: r.platform === "other" ? tr("entry.theSite") : r.platform_label,
            })}
          </a>
        )}
      </div>
      {!unread && (
        <p className="rv-fine">
          {r.drafts_left === 0 ? tr("entry.noneLeft") : tr("entry.left", { count: r.drafts_left })}
        </p>
      )}
      {busy === "draft" && (
        <p className="rv-fine live">
          <span className="live-dot" aria-hidden="true" /> {tr("entry.draftingLive")}
        </p>
      )}
      {r.draft && r.post.can && !r.post.state && <p className="rv-fine">{tr("entry.postNote")}</p>}
      {r.draft && !r.post.can && r.platform !== "google" && (
        <p className="rv-fine">{tr("entry.notGoogle", { site })}</p>
      )}
      {r.draft && !r.post.can && r.source === "google" && googleConnected && (
        <p className="rv-fine">{tr("entry.reconnect")}</p>
      )}
      {r.post.state && <p className="rv-fine">{tr(`entry.postState.${r.post.state}`)}</p>}
      {note && <p className="rv-note">{note}</p>}
      {answerWhy && <p className="rv-fine">{answerWhy}</p>}

      <p className="rv-remove">
        {answerWhy ? null : confirm ? (
          <>
            {tr("entry.removeAsk")}{" "}
            <button
              type="button"
              className="rv-textbtn"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "remove" ? tr("entry.removing") : tr("entry.removeYes")}
            </button>{" "}
            <button type="button" className="rv-textbtn" onClick={() => setConfirm(false)}>
              {tr("entry.keep")}
            </button>
          </>
        ) : (
          <button type="button" className="rv-textbtn" onClick={() => setConfirm(true)}>
            {tr("entry.remove")}
          </button>
        )}
      </p>
    </li>
  );
}

function ForwardingCard({ view, post }: { view: ReviewsView; post: Post }) {
  const { tr, locale } = useTr("reviews");
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Idea 52: the forwarding address is a setting, so a new one is an owner's.
  const rotateWhy = useRole().why("reviews.settings");
  const address = view.forwarding.address;
  const gmail = view.forwarding.gmail;
  if (!view.forwarding.configured || !address) {
    return (
      <SheetCard label={tr("forwarding.label")} title={tr("forwarding.offTitle")}>
        <p className="rv-copy">{tr("forwarding.offCopy")}</p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={tr("forwarding.label")}
      title={tr("forwarding.title")}
      foot={
        <span className="rv-foot-row">
          {rotateWhy ? (
            <span>{rotateWhy}</span>
          ) : confirm ? (
            <>
              <span>{tr("forwarding.newStops")}</span>
              <button
                type="button"
                className="act"
                onClick={() => void post({ action: "rotate" }).then(() => setConfirm(false))}
              >
                {tr("forwarding.newAddress")}
              </button>
            </>
          ) : (
            <button type="button" className="rv-textbtn" onClick={() => setConfirm(true)}>
              {tr("forwarding.newAddress")}
            </button>
          )}
        </span>
      }
    >
      <p className="rv-address">{address}</p>
      <button type="button" className="act" onClick={() => void copyText(address).then(setCopied)}>
        {copied ? tr("forwarding.copied") : tr("forwarding.copyAddress")}
      </button>
      {gmail && (
        <p className="rv-copy">
          <strong>{gmailConfirmationLine(gmail, tr)}</strong>{" "}
          <span className="rv-quiet">
            {tr("gmail.received", { day: dayLabel(gmail.at, view.today, locale) })}
          </span>
          {gmail.link && (
            <>
              {" "}
              <a href={gmail.link} target="_blank" rel="noopener noreferrer">
                {tr("gmail.openLink")}
              </a>
            </>
          )}
        </p>
      )}
      <Fold>
        <p>{tr("forwarding.how")}</p>
        {setupSteps(tr).map((s) => (
          <div key={s.platform} className="rv-steps">
            <p className="cs-label">{s.platform}</p>
            <ol>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </Fold>
    </SheetCard>
  );
}

/**
 * I-45a: reading reviews straight from Google Business Profile. Granted on
 * Connections, under its own consent; this card says what that permission
 * can do, what SYB does with it, and what has to be in place first.
 */
function GoogleCard({ view }: { view: ReviewsView }) {
  const { tr, locale } = useTr("reviews");
  const g = view.google;
  const title = g.connected
    ? g.failed
      ? tr("google.failed")
      : g.location_title
        ? tr("google.readingFor", { location: g.location_title })
        : tr("google.reading")
    : g.configured
      ? tr("google.readDirectly")
      : tr("google.notSetUpTitle");
  return (
    <SheetCard
      label={tr("google.label")}
      title={title}
      foot={
        <span className="rv-foot-row">
          <Link href="/connections">
            {g.connected ? tr("google.manage") : tr("google.connect")}
          </Link>
        </span>
      }
    >
      {/* The server's fixed lines (lib/google-business/words), in the reader's language. */}
      <p className="rv-copy">{tr("google.whatItCanDo")}</p>
      {g.connected ? (
        <p className="rv-copy">
          {tr("google.connected")}
          {g.last_read && (
            <>
              {" "}
              <span className="rv-quiet">
                {tr("google.lastRead", { day: dayLabel(g.last_read.at, view.today, locale) })}
                {g.last_read.words ? ` ${g.last_read.words}` : ""}
              </span>
            </>
          )}
        </p>
      ) : (
        <>
          {g.not_set_up && <p className="rv-copy">{tr("google.notSetUp")}</p>}
          <div className="rv-steps">
            <p className="cs-label">{tr("google.before")}</p>
            <ol>
              {GOOGLE_NEED_KEYS.map((k) => (
                <li key={k}>{tr(`google.needs.${k}`)}</li>
              ))}
            </ol>
          </div>
        </>
      )}
    </SheetCard>
  );
}

function PasteCard({ view, post }: { view: ReviewsView; post: Post }) {
  const { tr, locale } = useTr("reviews");
  const [form, setForm] = useState({
    platform: "google",
    stars: "",
    reviewer: "",
    text: "",
    link: "",
    date: "",
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pasteWhy = useRole().why("reviews.answer");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const out = await post({ action: "paste", ...form });
    if (out?.filed === true) {
      setForm({ ...form, stars: "", reviewer: "", text: "", link: "", date: "" });
      setNote(tr("paste.filed"));
    } else if (out?.filed === false) {
      setNote(tr("paste.already"));
    }
    setBusy(false);
  };

  return (
    <SheetCard label={tr("paste.label")} title={tr("paste.title")}>
      {pasteWhy && <p className="rv-fine">{pasteWhy}</p>}
      <form className="rv-form" onSubmit={(e) => void submit(e)}>
        <fieldset className="role-lock" disabled={pasteWhy !== null}>
          <label className="cs-label" htmlFor="rv-platform">
            {tr("paste.where")}
          </label>
          <select
            id="rv-platform"
            className="rv-input"
            value={form.platform}
            onChange={set("platform")}
          >
            {view.platforms.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key === "other" ? tr("platform.other") : p.label}
              </option>
            ))}
          </select>
          <label className="cs-label" htmlFor="rv-stars">
            {tr("paste.stars")}
          </label>
          <select
            id="rv-stars"
            className="rv-input"
            value={form.stars}
            onChange={set("stars")}
            required
          >
            <option value="">{tr("paste.choose")}</option>
            {Array.from({ length: MAX_STARS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {starsWords(n, tr, locale)}
              </option>
            ))}
          </select>
          <label className="cs-label" htmlFor="rv-text">
            {tr("paste.text")}
          </label>
          <textarea
            id="rv-text"
            className="rv-textarea"
            rows={4}
            value={form.text}
            onChange={set("text")}
          />
          <label className="cs-label" htmlFor="rv-reviewer">
            {tr("paste.reviewer")}
          </label>
          <input
            id="rv-reviewer"
            className="rv-input"
            value={form.reviewer}
            onChange={set("reviewer")}
          />
          <label className="cs-label" htmlFor="rv-link">
            {tr("paste.link")}
          </label>
          <input
            id="rv-link"
            className="rv-input"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={form.link}
            onChange={set("link")}
          />
          <label className="cs-label" htmlFor="rv-date">
            {tr("paste.date")}
          </label>
          <input
            id="rv-date"
            className="rv-input"
            type="date"
            max={view.today}
            value={form.date}
            onChange={set("date")}
          />
          <div className="rv-actions">
            <button
              type="submit"
              className="act solid"
              disabled={busy || form.stars === "" || pasteWhy !== null}
            >
              {busy ? tr("paste.filing") : tr("paste.file")}
            </button>
          </div>
          {note && <p className="rv-note">{note}</p>}
        </fieldset>
      </form>
    </SheetCard>
  );
}

export function ReviewsScreen() {
  const { tr, locale } = useTr("reviews");
  const t = useTranslations("reviews");
  const [view, setView] = useState<ReviewsView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/reviews");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as ReviewsView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const post: Post = async (body) => {
    setError(null);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof out.error === "string" ? `${out.error}.` : tr("entry.failed"));
        return null;
      }
      await load();
      return out;
    } catch {
      setError(tr("screen.ourSide"));
      return null;
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("screen.noBusiness")}>
        <p className="rv-wait">
          {t.rich("screen.startInterview", {
            link: (c) => <Link href="/intake">{c}</Link>,
          })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("screen.failedTitle")}>
        <p className="rv-wait">{tr("screen.failedCopy")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("screen.loading")} />;

  const month = thisMonth(view.reviews, view.today);
  return (
    <Frame title={reviewsHeadline(view, tr)} aside={asideLine(view, tr)}>
      {error && <p className="rv-note rv-error">{error}</p>}
      <SheetCard
        label={tr("screen.listLabel", {
          month: monthName(view.today, tr, locale),
          count: num(month.length, 0, locale),
        })}
        title={view.reviews.length > 0 ? tr("screen.listTitle") : tr("screen.nothingFiled")}
        meta={tr("screen.listMeta", { stars: POOR_STARS })}
      >
        {view.reviews.length > 0 ? (
          <ul className="rv-list">
            {view.reviews.map((r) => (
              <ReviewEntry
                key={r.id}
                r={r}
                today={view.today}
                post={post}
                googleConnected={view.google.connected}
              />
            ))}
          </ul>
        ) : (
          <p className="rv-copy">{tr("screen.emptyCopy")}</p>
        )}
      </SheetCard>
      <GoogleCard view={view} />
      <div className="rv-grid">
        <ForwardingCard view={view} post={post} />
        <PasteCard view={view} post={post} />
      </div>
    </Frame>
  );
}
