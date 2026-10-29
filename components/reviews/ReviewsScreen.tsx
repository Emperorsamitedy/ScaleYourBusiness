"use client";

// Customers · Reviews — idea 45, on the sheet system (app/sheet.css).
// The head is the month's main fact: how many reviews were 3 stars or
// fewer, of how many. Then every review on file, newest first, with its
// platform, its stars in words, when, the words, and "Suggest a reply";
// the forwarding address with plain setup steps; and a "Paste a review"
// form. SYB never posts a reply: a suggestion is text to edit and copy,
// with a link to where the review lives.

import "../../app/reviews.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ReviewItem, ReviewsView } from "../../lib/review-desk/view";
import { PageHead, SheetCard } from "../sheet/PageHead";
import {
  SETUP_STEPS,
  asideLine,
  dayLabel,
  monthName,
  readNote,
  reviewsHeadline,
  starsWords,
  thisMonth,
} from "./reviews-view";

const FOOT =
  "SYB never posts a reply and never signs in to your review sites. A reviewer's name is kept for a year, and you can remove any review at once.";

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
  return (
    <main className="screen rv-screen">
      <PageHead kicker="Customers · Reviews" title={title} aside={aside} />
      {children}
      <p className="rv-foot">{FOOT}</p>
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

function ReviewEntry({ r, today, post }: { r: ReviewItem; today: string; post: Post }) {
  const [draft, setDraft] = useState(r.draft ?? "");
  const [busy, setBusy] = useState<"draft" | "remove" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(r.draft ?? ""), [r.draft]);
  const unread = r.stars === null && r.text === null;
  const read = readNote(r);

  const suggest = async () => {
    setBusy("draft");
    setNote(null);
    const out = await post({ action: "draft", id: r.id });
    if (out && out.drafted !== true) {
      setNote(typeof out.message === "string" ? out.message : "That didn't work.");
    }
    setBusy(null);
  };
  const remove = async () => {
    setBusy("remove");
    await post({ action: "remove", id: r.id });
    setBusy(null);
  };

  return (
    <li className={`rv-item${r.worth_knowing ? " rv-worth" : ""}`}>
      <p className="rv-line">
        <span className="rv-platform">{r.platform_label}</span>
        <span>{starsWords(r.stars)}</span>
        <span>{dayLabel(r.reviewed_at, today)}</span>
        {r.worth_knowing && <span className="word drift">Worth knowing</span>}
      </p>
      {r.reviewer && <p className="rv-who">{r.reviewer}</p>}
      {r.text ? (
        <p className="rv-text">{r.text}</p>
      ) : (
        !unread && <p className="rv-text rv-quiet">A rating with no words.</p>
      )}
      {read && <p className="rv-fine">{read}</p>}

      {r.draft && (
        <div className="rv-draft">
          <label className="cs-label" htmlFor={`draft-${r.id}`}>
            Suggested reply · yours to edit
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
          <p className="rv-fine">
            I drafted this. Read it and make it yours: once you post it, it&apos;s your words, under
            your name. I never post anything.
          </p>
        </div>
      )}

      <div className="rv-actions">
        {r.draft ? (
          <button
            type="button"
            className="act solid"
            disabled={draft.trim() === ""}
            onClick={() => void copyText(draft).then(setCopied)}
          >
            {copied ? "Copied" : "Copy the reply"}
          </button>
        ) : null}
        {!unread && (
          <button
            type="button"
            className="act"
            disabled={busy !== null || r.drafts_left === 0}
            onClick={() => void suggest()}
          >
            {busy === "draft" ? "Drafting…" : r.draft ? "Suggest another →" : "Suggest a reply →"}
          </button>
        )}
        {r.link && (
          <a className="rv-link" href={r.link} target="_blank" rel="noopener noreferrer">
            Open on {r.platform === "other" ? "the site" : r.platform_label} ↗
          </a>
        )}
      </div>
      {!unread && (
        <p className="rv-fine">
          {r.drafts_left === 0
            ? "No suggestions left for this review: write it yourself."
            : `${r.drafts_left} ${r.drafts_left === 1 ? "suggestion" : "suggestions"} left for this review.`}
        </p>
      )}
      {busy === "draft" && (
        <p className="rv-fine live">
          <span className="live-dot" aria-hidden="true" /> Drafting a reply
        </p>
      )}
      {note && <p className="rv-note">{note}</p>}

      <p className="rv-remove">
        {confirm ? (
          <>
            Remove this review, the name on it and any suggested reply?{" "}
            <button
              type="button"
              className="rv-textbtn"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "remove" ? "Removing…" : "Yes, remove it"}
            </button>{" "}
            <button type="button" className="rv-textbtn" onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="rv-textbtn" onClick={() => setConfirm(true)}>
            Remove this review
          </button>
        )}
      </p>
    </li>
  );
}

function ForwardingCard({ view, post }: { view: ReviewsView; post: Post }) {
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const address = view.forwarding.address;
  if (!view.forwarding.configured || !address) {
    return (
      <SheetCard label="Forwarding" title="Forwarding isn't set up yet">
        <p className="rv-copy">
          Once SYB&apos;s inbound email is switched on, you&apos;ll get an address here to forward
          your review emails to, and I&apos;ll file each one as it comes. Until then, paste a review
          below and I&apos;ll file it the same way.
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label="Forwarding"
      title="Forward review emails here"
      foot={
        <span className="rv-foot-row">
          {confirm ? (
            <>
              <span>A new address stops this one working. Update your forwarding after.</span>
              <button
                type="button"
                className="act"
                onClick={() => void post({ action: "rotate" }).then(() => setConfirm(false))}
              >
                Get a new address
              </button>
            </>
          ) : (
            <button type="button" className="rv-textbtn" onClick={() => setConfirm(true)}>
              Get a new address
            </button>
          )}
        </span>
      }
    >
      <p className="rv-address">{address}</p>
      <button type="button" className="act" onClick={() => void copyText(address).then(setCopied)}>
        {copied ? "Copied" : "Copy the address"}
      </button>
      <p className="rv-copy">
        Each review email you forward becomes a review here. A poor one goes on your Watching screen
        the day it comes in, and into your weekly summary. Mail from anyone but a review site is
        ignored.
      </p>
      {SETUP_STEPS.map((s) => (
        <div key={s.platform} className="rv-steps">
          <p className="cs-label">{s.platform}</p>
          <ol>
            {s.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ))}
    </SheetCard>
  );
}

function PasteCard({ view, post }: { view: ReviewsView; post: Post }) {
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
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const out = await post({ action: "paste", ...form });
    if (out?.filed === true) {
      setForm({ ...form, stars: "", reviewer: "", text: "", link: "", date: "" });
      setNote("Filed.");
    } else if (out?.filed === false) {
      setNote("That review is already here.");
    }
    setBusy(false);
  };

  return (
    <SheetCard label="Paste a review" title="Saw one somewhere else?">
      <form className="rv-form" onSubmit={(e) => void submit(e)}>
        <label className="cs-label" htmlFor="rv-platform">
          Where it was left
        </label>
        <select
          id="rv-platform"
          className="rv-input"
          value={form.platform}
          onChange={set("platform")}
        >
          {view.platforms.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <label className="cs-label" htmlFor="rv-stars">
          Stars
        </label>
        <select
          id="rv-stars"
          className="rv-input"
          value={form.stars}
          onChange={set("stars")}
          required
        >
          <option value="">Choose</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} of 5
            </option>
          ))}
        </select>
        <label className="cs-label" htmlFor="rv-text">
          What they wrote
        </label>
        <textarea
          id="rv-text"
          className="rv-textarea"
          rows={4}
          value={form.text}
          onChange={set("text")}
        />
        <label className="cs-label" htmlFor="rv-reviewer">
          Their name as the site shows it · optional
        </label>
        <input
          id="rv-reviewer"
          className="rv-input"
          value={form.reviewer}
          onChange={set("reviewer")}
        />
        <label className="cs-label" htmlFor="rv-link">
          Link to the review · optional
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
          When it was left · optional, else today
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
          <button type="submit" className="act solid" disabled={busy || form.stars === ""}>
            {busy ? "Filing…" : "File this review"}
          </button>
        </div>
        {note && <p className="rv-note">{note}</p>}
      </form>
    </SheetCard>
  );
}

export function ReviewsScreen() {
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
        setError(typeof out.error === "string" ? `${out.error}.` : "That didn't work.");
        return null;
      }
      await load();
      return out;
    } catch {
      setError("Something went wrong on our side.");
      return null;
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="rv-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Reviews didn't load.">
        <p className="rv-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your reviews…" />;

  const month = thisMonth(view.reviews, view.today);
  return (
    <Frame title={reviewsHeadline(view)} aside={asideLine(view)}>
      {error && <p className="rv-note rv-error">{error}</p>}
      <SheetCard
        label={`Reviews · ${monthName(view.today)}: ${month.length} · newest first`}
        title={view.reviews.length > 0 ? "What people said" : "Nothing filed yet"}
        meta="3 stars or fewer is worth knowing"
      >
        {view.reviews.length > 0 ? (
          <ul className="rv-list">
            {view.reviews.map((r) => (
              <ReviewEntry key={r.id} r={r} today={view.today} post={post} />
            ))}
          </ul>
        ) : (
          <p className="rv-copy">
            Forward a review email to the address below, or paste one, and it shows here.
          </p>
        )}
      </SheetCard>
      <div className="rv-grid">
        <ForwardingCard view={view} post={post} />
        <PasteCard view={view} post={post} />
      </div>
    </Frame>
  );
}
