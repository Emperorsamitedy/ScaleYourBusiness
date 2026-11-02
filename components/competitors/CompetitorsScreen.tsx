"use client";

// Insights · Competitors — feature 35, on the sheet system. Who I watch
// and when I last read them (or that I haven't, or couldn't), their
// prices beside yours, and what moved, each as a worded flag. Read-only
// about the world: the only actions are on the owner's own list, and a
// fresh read of pages they listed. Nothing here changes a price.
//
// L-3b (TASKS-LANGUAGES.md): the screen's own words are the "competitors"
// catalogue; figures, money and dates in the reader's locale, each price in
// its own currency. What the read found (their offer names, a change's
// sentence, a gap's words, a read's problem) is said as lib/ built it — L-4.

import "../../app/competitors.css";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ChangeFlag } from "../../lib/competitors/changes";
import type {
  CompetitorCard,
  CompetitorsView,
  PriceRow,
  ReadState,
} from "../../lib/competitors/view";
import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The most other pages a competitor may list: lib/competitors/service MAX_PRICE_PAGES (server-only). */
const MAX_PRICE_PAGES = 3;

/** "19 Oct", in UTC so server and browser agree. */
function dayText(iso: string, locale: AppLocale = "en"): string {
  const d = new Date(iso);
  if (locale !== "en") return Number.isNaN(d.getTime()) ? "" : dayMonth(d.toISOString(), locale);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A rating as the read found it ("4.7", "5"), in the reader's writing. */
function ratingText(rating: number, locale: AppLocale): string {
  const decimals = String(rating).split(".")[1]?.length ?? 0;
  return num(rating, decimals, locale);
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The word each change carries, and the tint it gets. The word carries the meaning. */
const FLAG_TINT: Record<ChangeFlag, string> = {
  CHEAPER: "drift",
  DEARER: "low",
  NEW: "low",
  GONE: "low",
  CHANGED: "low",
  RATING: "low",
};

export function headline(
  view: CompetitorsView,
  tr: Tr = englishTr("competitors"),
  locale: AppLocale = "en",
): string {
  const n = view.competitors.length;
  if (n === 0) return tr("headline.none");
  const read = view.competitors.filter(
    (c) => c.read.state !== "unread" && c.read.state !== "failed",
  );
  if (read.length === 0) return tr("headline.unread", { count: n });
  const { matched, below } = view.summary;
  if (matched === 0) {
    return tr("headline.noMatch", { read: num(read.length, 0, locale), count: n });
  }
  if (below === 0) return tr("headline.noneBelow", { matched });
  return tr("headline.below", { below: num(below, 0, locale), matched });
}

function readWords(
  c: CompetitorCard,
  tr: Tr,
  locale: AppLocale,
): { state: ReadState; text: string; title?: string } {
  const r = c.read;
  if (c.pages === 0) return { state: "unread", text: tr("read.noPages") };
  if (r.state === "unread") return { state: "unread", text: tr("read.notYet") };
  const first = r.problems[0];
  if (r.state === "failed") {
    return {
      state: "failed",
      text: tr("read.failed", { reason: first?.reason ?? tr("read.noAnswer") }),
      ...(r.at ? { title: tr("read.tried", { day: dayText(r.at, locale) }) } : {}),
    };
  }
  const at = r.at ? dayText(r.at, locale) : "";
  if (r.state === "partial") {
    return {
      state: "partial",
      text: tr("read.partial", {
        day: at,
        count: r.problems.length,
        reason: first?.reason ?? "",
      }),
    };
  }
  return { state: "read", text: tr("read.done", { day: at }) };
}

/* ── the add / edit form ── */

interface Draft {
  name: string;
  url: string;
  listing_url: string;
  price_pages: string;
}

const emptyDraft: Draft = { name: "", url: "", listing_url: "", price_pages: "" };

function draftOf(c: CompetitorCard): Draft {
  return {
    name: c.name,
    url: c.url ?? "",
    listing_url: c.listing_url ?? "",
    price_pages: c.price_pages.join("\n"),
  };
}

function CompetitorForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const { tr } = useTr("competitors");
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (k: keyof Draft) => ({
    value: d[k],
    onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }),
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await onSubmit(d));
    setBusy(false);
  };
  return (
    <form className="cp-form" onSubmit={submit}>
      <label>
        <span>{tr("form.name")}</span>
        <input {...field("name")} required maxLength={120} autoComplete="off" />
      </label>
      <label>
        <span>{tr("form.website")}</span>
        <input
          {...field("url")}
          placeholder={tr("form.websitePlaceholder")}
          inputMode="url"
          autoComplete="off"
        />
      </label>
      <label>
        <span>{tr("form.listing")}</span>
        <input
          {...field("listing_url")}
          placeholder={tr("form.listingPlaceholder")}
          inputMode="url"
          autoComplete="off"
        />
      </label>
      <label className="cp-wide">
        <span>{tr("form.otherPages", { max: MAX_PRICE_PAGES })}</span>
        <textarea {...field("price_pages")} rows={2} />
      </label>
      <p className="cp-note cp-wide">{tr("form.note")}</p>
      {error && (
        <p className="cp-error cp-wide" role="alert">
          {error}
        </p>
      )}
      <div className="cp-actions cp-wide">
        <button type="submit" className="act solid" disabled={busy}>
          {busy ? tr("form.saving") : submitLabel}
        </button>
        <button type="button" className="act" onClick={onCancel} disabled={busy}>
          {tr("form.cancel")}
        </button>
      </div>
    </form>
  );
}

/* ── the cards ── */

function WatchList({
  view,
  reading,
  onRead,
  onSave,
  onRemove,
}: {
  view: CompetitorsView;
  reading: string | null;
  onRead: (id: string) => void;
  onSave: (id: string | null, d: Draft) => Promise<string | null>;
  onRemove: (id: string) => void;
}) {
  const { tr, locale } = useTr("competitors");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = view.competitors;
  return (
    <SheetCard
      label={tr("watch.label")}
      title={list.length === 0 ? tr("watch.nobody") : tr("watch.count", { count: list.length })}
      meta={tr("watch.meta")}
      foot={
        editing === "new" ? undefined : (
          <span className="cp-foot-row">
            <span>{tr("watch.foot")}</span>
            <button type="button" className="act" onClick={() => setEditing("new")}>
              {tr("watch.addOne")}
            </button>
          </span>
        )
      }
    >
      {editing === "new" && (
        <CompetitorForm
          initial={emptyDraft}
          submitLabel={tr("watch.add")}
          onCancel={() => setEditing(null)}
          onSubmit={async (d) => {
            const error = await onSave(null, d);
            if (error === null) setEditing(null);
            return error;
          }}
        />
      )}
      {list.length === 0 && editing !== "new" ? (
        <p className="cp-copy">{tr("watch.empty")}</p>
      ) : (
        <ul className="cp-list">
          {list.map((c) => {
            const w = readWords(c, tr, locale);
            const busy = reading === c.id;
            return (
              <li key={c.id}>
                {editing === c.id ? (
                  <CompetitorForm
                    initial={draftOf(c)}
                    submitLabel={tr("watch.save")}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (d) => {
                      const error = await onSave(c.id, d);
                      if (error === null) setEditing(null);
                      return error;
                    }}
                  />
                ) : (
                  <div className="cp-row">
                    <div className="cp-who">
                      <strong>{c.name}</strong>
                      <span className="cp-src">
                        {[...new Set([host(c.url), host(c.listing_url)].filter(Boolean))].join(
                          " · ",
                        ) || tr("watch.noPagesListed")}
                        {c.pages > 0 && ` · ${tr("watch.pages", { count: c.pages })}`}
                      </span>
                    </div>
                    <div className="cp-state">
                      {busy ? (
                        <span className="live">
                          <span className="live-dot" aria-hidden="true" /> {tr("watch.reading")}
                        </span>
                      ) : (
                        <span className={`cp-read ${w.state}`} title={w.title}>
                          {w.text}
                        </span>
                      )}
                      <span className="cp-src">
                        {c.offers_seen > 0
                          ? tr("watch.prices", { count: c.offers_seen })
                          : c.read.state === "unread"
                            ? ""
                            : tr("watch.noPrices")}
                        {c.rating &&
                          ` · ${
                            c.rating.count !== null
                              ? tr("watch.ratedCount", {
                                  rating: ratingText(c.rating.rating, locale),
                                  count: num(c.rating.count, 0, locale),
                                })
                              : tr("watch.rated", { rating: ratingText(c.rating.rating, locale) })
                          }`}
                      </span>
                    </div>
                    <div className="cp-row-acts">
                      <button
                        type="button"
                        className="act"
                        disabled={busy || reading !== null || c.pages === 0}
                        onClick={() => onRead(c.id)}
                      >
                        {tr("watch.readNow")}
                      </button>
                      <button type="button" className="act" onClick={() => setEditing(c.id)}>
                        {tr("watch.edit")}
                      </button>
                      <button type="button" className="act" onClick={() => onRemove(c.id)}>
                        {tr("watch.remove")}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SheetCard>
  );
}

function Changes({ view }: { view: CompetitorsView }) {
  const { tr, locale } = useTr("competitors");
  const list = view.changes;
  return (
    <SheetCard
      label={tr("changes.label")}
      title={list.length === 0 ? tr("changes.none") : tr("changes.title")}
    >
      {list.length === 0 ? (
        <p className="cp-copy">{tr("changes.empty")}</p>
      ) : (
        <ul className="cp-changes">
          {list.slice(0, 8).map((ch) => (
            <li key={`${ch.at}-${ch.sentence}`}>
              <span className={`flag ${FLAG_TINT[ch.flag]}`}>
                {tr(`flag.${ch.flag.toLowerCase()}`)}
              </span>
              <p>{ch.sentence}</p>
              <span className="cp-at">{dayText(ch.at, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

/** How a match was made: "basis.<key>" in the catalogue. */
const BASIS = new Set(["owner", "name", "category"]);

function priceCell(r: Pick<PriceRow, "their_price" | "from">, tr: Tr, locale: AppLocale): string {
  const price = moneyText(r.their_price.amount_minor, r.their_price.currency, locale);
  return r.from ? tr("prices.from", { price }) : price;
}

function PriceTable({
  view,
  onMatch,
}: {
  view: CompetitorsView;
  onMatch: (row: PriceRow, offerId: string | null) => void;
}) {
  const { tr, locale } = useTr("competitors");
  const t = useTranslations("competitors");
  const rows = view.rows.slice(0, 80);
  if (view.rows.length === 0) {
    return (
      <SheetCard label={tr("prices.label")} title={tr("prices.noneTitle")}>
        <p className="cp-copy">
          {view.competitors.length === 0 ? tr("prices.emptyNone") : tr("prices.emptyRead")}{" "}
          {view.own_offers.length === 0 &&
            t.rich("prices.ownOffers", { link: (c) => <Link href="/profile">{c}</Link> })}
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={tr("prices.label")}
      title={tr("prices.title", {
        matched: num(view.summary.matched, 0, locale),
        total: view.rows.length,
      })}
      meta={tr("prices.meta")}
      foot={tr("prices.foot")}
    >
      <div className="cp-table-wrap" tabIndex={0} aria-label={tr("prices.label")}>
        <table className="rt cp-table">
          <thead>
            <tr>
              <th scope="col">{tr("prices.theirOffer")}</th>
              <th scope="col">{tr("prices.competitor")}</th>
              <th scope="col" className="num">
                {tr("prices.theirs")}
              </th>
              <th scope="col">{tr("prices.comparedWith")}</th>
              <th scope="col" className="num">
                {tr("prices.yours")}
              </th>
              <th scope="col">{tr("prices.difference")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.competitor_id}-${r.key}`}>
                <th scope="row">
                  {r.their_name}
                  <span className="cp-src cp-how">
                    {r.method === "model"
                      ? tr("prices.byModel")
                      : r.method === "pattern"
                        ? tr("prices.fromText")
                        : r.method === "og"
                          ? tr("prices.fromTags")
                          : tr("prices.fromData")}
                  </span>
                </th>
                <td>{r.competitor}</td>
                <td className="num">{priceCell(r, tr, locale)}</td>
                <td>
                  <select
                    className="cp-match"
                    aria-label={tr("prices.matchLabel", { name: r.their_name })}
                    value={r.basis === null ? "none" : (r.yours?.id ?? "none")}
                    onChange={(e) => onMatch(r, e.target.value)}
                  >
                    <option value="none">{tr("prices.nothingOfMine")}</option>
                    {view.own_offers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {r.basis && BASIS.has(r.basis) && (
                    <span className="cp-src cp-how">{tr(`basis.${r.basis}`)}</span>
                  )}
                </td>
                <td className="num">
                  {r.yours?.price
                    ? moneyText(r.yours.price.amount_minor, r.yours.price.currency, locale)
                    : "—"}
                </td>
                <td className="cp-gap">
                  {r.gap ? (
                    <span className={r.gap.diff_minor < 0 ? "word drift" : "word low"}>
                      {r.gap.words}
                    </span>
                  ) : (
                    <span className="cp-src">{r.note ?? "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.rows.length > rows.length && (
        <p className="cp-note">
          {tr("prices.showing", { shown: num(rows.length, 0, locale), total: view.rows.length })}
        </p>
      )}
    </SheetCard>
  );
}

/* ── the screen ── */

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useTr("competitors");
  return (
    <main className="screen cp-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

async function errorOf(res: Response, tr: Tr): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? tr("screen.failed");
  } catch {
    return tr("screen.failed");
  }
}

export function CompetitorsScreen() {
  const { tr, locale } = useTr("competitors");
  const t = useTranslations("competitors");
  const [view, setView] = useState<CompetitorsView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/competitors");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as CompetitorsView);
    } catch {
      setFailed("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string | null, d: Draft): Promise<string | null> => {
    const res = await fetch(id ? `/api/competitors/${id}` : "/api/competitors", {
      method: id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(d),
    });
    if (!res.ok) return errorOf(res, tr);
    await load();
    return null;
  };

  const read = async (id: string) => {
    setReading(id);
    setNotice(null);
    const res = await fetch(`/api/competitors/${id}/read`, { method: "POST" });
    if (!res.ok) setNotice(await errorOf(res, tr));
    setReading(null);
    await load();
  };

  const remove = async (id: string) => {
    const name = view?.competitors.find((c) => c.id === id)?.name ?? tr("screen.thisCompetitor");
    if (!window.confirm(tr("screen.confirmRemove", { name }))) return;
    const res = await fetch(`/api/competitors/${id}`, { method: "DELETE" });
    if (!res.ok) setNotice(await errorOf(res, tr));
    await load();
  };

  const match = async (row: PriceRow, offerId: string | null) => {
    const res = await fetch(`/api/competitors/${row.competitor_id}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: row.key, offer_id: offerId }),
    });
    if (!res.ok) setNotice(await errorOf(res, tr));
    await load();
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("screen.noBusiness")}>
        <p className="cp-wait">
          {t.rich("screen.startInterview", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("screen.failedTitle")}>
        <p className="cp-wait">{tr("screen.failedCopy")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("screen.loading")} />;

  return (
    <Frame title={headline(view, tr, locale)} aside={tr("aside")}>
      {notice && (
        <p className="cp-notice" role="status">
          {notice}
        </p>
      )}
      <div className="cp-grid">
        <WatchList view={view} reading={reading} onRead={read} onSave={save} onRemove={remove} />
        <Changes view={view} />
      </div>
      <PriceTable view={view} onMatch={match} />
    </Frame>
  );
}
