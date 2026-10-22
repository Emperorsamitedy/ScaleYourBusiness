"use client";

// Insights · Competitors — feature 35, on the sheet system. Who I watch
// and when I last read them (or that I haven't, or couldn't), their
// prices beside yours, and what moved, each as a worded flag. Read-only
// about the world: the only actions are on the owner's own list, and a
// fresh read of pages they listed. Nothing here changes a price.

import "../../app/competitors.css";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import type { ChangeFlag } from "../../lib/competitors/changes";
import type {
  CompetitorCard,
  CompetitorsView,
  PriceRow,
  ReadState,
} from "../../lib/competitors/view";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Oct", in UTC so server and browser agree. */
function dayText(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
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

export function headline(view: CompetitorsView): string {
  const n = view.competitors.length;
  if (n === 0) return "You haven't listed any competitors yet.";
  const read = view.competitors.filter(
    (c) => c.read.state !== "unread" && c.read.state !== "failed",
  );
  if (read.length === 0) {
    return `I'm watching ${n} competitor${n === 1 ? "" : "s"}, and haven't read their prices yet.`;
  }
  const { matched, below } = view.summary;
  if (matched === 0) {
    return `I've read ${read.length} of ${n} competitor${n === 1 ? "" : "s"}; none of their prices match an offer of yours yet.`;
  }
  if (below === 0) {
    return `None of ${matched} matched price${matched === 1 ? "" : "s"} is below yours.`;
  }
  return `${below} of ${matched} matched price${matched === 1 ? " is" : "s are"} below yours.`;
}

function readWords(c: CompetitorCard): { state: ReadState; text: string; title?: string } {
  const r = c.read;
  if (c.pages === 0) return { state: "unread", text: "No pages to read" };
  if (r.state === "unread") return { state: "unread", text: "Not read yet" };
  const first = r.problems[0];
  if (r.state === "failed") {
    return {
      state: "failed",
      text: `Couldn't read: ${first?.reason ?? "no page answered"}`,
      ...(r.at ? { title: `Tried ${dayText(r.at)}` } : {}),
    };
  }
  const at = r.at ? dayText(r.at) : "";
  if (r.state === "partial") {
    return {
      state: "partial",
      text: `Read ${at}; ${r.problems.length} page${r.problems.length === 1 ? "" : "s"} not: ${first?.reason ?? ""}`,
    };
  }
  return { state: "read", text: `Read ${at}` };
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
        <span>Name</span>
        <input {...field("name")} required maxLength={120} autoComplete="off" />
      </label>
      <label>
        <span>Their website</span>
        <input
          {...field("url")}
          placeholder="their web address"
          inputMode="url"
          autoComplete="off"
        />
      </label>
      <label>
        <span>Booking or listing page</span>
        <input
          {...field("listing_url")}
          placeholder="Fresha, Treatwell, Booksy, Google, a shop page"
          inputMode="url"
          autoComplete="off"
        />
      </label>
      <label className="cp-wide">
        <span>Other pages with their prices, one per line (up to 3)</span>
        <textarea {...field("price_pages")} rows={2} />
      </label>
      <p className="cp-note cp-wide">
        I read only these pages, once a week. I never log in anywhere, and I skip any page their
        robots.txt asks robots to leave alone.
      </p>
      {error && (
        <p className="cp-error cp-wide" role="alert">
          {error}
        </p>
      )}
      <div className="cp-actions cp-wide">
        <button type="submit" className="act solid" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="act" onClick={onCancel} disabled={busy}>
          Cancel
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
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = view.competitors;
  return (
    <SheetCard
      label="Who I'm watching"
      title={
        list.length === 0
          ? "Nobody yet"
          : `${list.length} competitor${list.length === 1 ? "" : "s"}`
      }
      meta="Their public pages, read weekly"
      foot={
        editing === "new" ? undefined : (
          <span className="cp-foot-row">
            <span>Names come from your interview answers and from what you add here.</span>
            <button type="button" className="act" onClick={() => setEditing("new")}>
              Add a competitor →
            </button>
          </span>
        )
      }
    >
      {editing === "new" && (
        <CompetitorForm
          initial={emptyDraft}
          submitLabel="Add"
          onCancel={() => setEditing(null)}
          onSubmit={async (d) => {
            const error = await onSave(null, d);
            if (error === null) setEditing(null);
            return error;
          }}
        />
      )}
      {list.length === 0 && editing !== "new" ? (
        <p className="cp-copy">
          Tell me who you compete with: their website, and the booking or listing page where their
          prices are. I read those pages and nothing else.
        </p>
      ) : (
        <ul className="cp-list">
          {list.map((c) => {
            const w = readWords(c);
            const busy = reading === c.id;
            return (
              <li key={c.id}>
                {editing === c.id ? (
                  <CompetitorForm
                    initial={draftOf(c)}
                    submitLabel="Save"
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
                        ) || "no pages listed"}
                        {c.pages > 0 && ` · ${c.pages} page${c.pages === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <div className="cp-state">
                      {busy ? (
                        <span className="live">
                          <span className="live-dot" aria-hidden="true" /> Reading their pages…
                        </span>
                      ) : (
                        <span className={`cp-read ${w.state}`} title={w.title}>
                          {w.text}
                        </span>
                      )}
                      <span className="cp-src">
                        {c.offers_seen > 0
                          ? `${num(c.offers_seen)} price${c.offers_seen === 1 ? "" : "s"}`
                          : c.read.state === "unread"
                            ? ""
                            : "no prices seen"}
                        {c.rating &&
                          ` · rated ${c.rating.rating}${c.rating.count !== null ? ` (${num(c.rating.count)})` : ""}`}
                      </span>
                    </div>
                    <div className="cp-row-acts">
                      <button
                        type="button"
                        className="act"
                        disabled={busy || reading !== null || c.pages === 0}
                        onClick={() => onRead(c.id)}
                      >
                        Read now
                      </button>
                      <button type="button" className="act" onClick={() => setEditing(c.id)}>
                        Edit
                      </button>
                      <button type="button" className="act" onClick={() => onRemove(c.id)}>
                        Remove
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
  const list = view.changes;
  return (
    <SheetCard
      label="Recent changes"
      title={list.length === 0 ? "Nothing moved yet" : "What moved"}
    >
      {list.length === 0 ? (
        <p className="cp-copy">
          Each week I compare their pages with the last read. A price cut or rise, an offer added or
          gone, or a rating that moved shows up here and in Watching.
        </p>
      ) : (
        <ul className="cp-changes">
          {list.slice(0, 8).map((ch) => (
            <li key={`${ch.at}-${ch.sentence}`}>
              <span className={`flag ${FLAG_TINT[ch.flag]}`}>{ch.flag}</span>
              <p>{ch.sentence}</p>
              <span className="cp-at">{dayText(ch.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

const BASIS: Record<string, string> = {
  owner: "your match",
  name: "same name",
  category: "same kind",
};

function priceCell(r: Pick<PriceRow, "their_price" | "from">): string {
  return `${r.from ? "from " : ""}${moneyText(r.their_price.amount_minor, r.their_price.currency)}`;
}

function PriceTable({
  view,
  onMatch,
}: {
  view: CompetitorsView;
  onMatch: (row: PriceRow, offerId: string | null) => void;
}) {
  const rows = view.rows.slice(0, 80);
  if (view.rows.length === 0) {
    return (
      <SheetCard label="Their prices beside yours" title="No prices to compare yet">
        <p className="cp-copy">
          {view.competitors.length === 0
            ? "Once you list a competitor and I've read their pages, their prices sit here beside yours."
            : "When a read finds prices on their pages, they sit here beside yours."}{" "}
          {view.own_offers.length === 0 && (
            <>
              Your own offers come from your <Link href="/profile">fact sheet</Link>.
            </>
          )}
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label="Their prices beside yours"
      title={`${num(view.summary.matched)} of ${num(view.rows.length)} of their prices compare with yours`}
      meta="Matched by name or by kind of service; change any match"
      foot="A comparison is something for you to weigh. I never change a price."
    >
      <div className="cp-table-wrap" tabIndex={0} aria-label="Their prices beside yours">
        <table className="rt cp-table">
          <thead>
            <tr>
              <th scope="col">Their offer</th>
              <th scope="col">Competitor</th>
              <th scope="col" className="num">
                Theirs
              </th>
              <th scope="col">Compared with</th>
              <th scope="col" className="num">
                Yours
              </th>
              <th scope="col">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.competitor_id}-${r.key}`}>
                <th scope="row">
                  {r.their_name}
                  <span className="cp-src cp-how">
                    {r.method === "model"
                      ? "read by the model"
                      : `read from ${r.method === "pattern" ? "the page text" : r.method === "og" ? "page tags" : "page data"}`}
                  </span>
                </th>
                <td>{r.competitor}</td>
                <td className="num">{priceCell(r)}</td>
                <td>
                  <select
                    className="cp-match"
                    aria-label={`Which of your offers ${r.their_name} compares with`}
                    value={r.basis === null ? "none" : (r.yours?.id ?? "none")}
                    onChange={(e) => onMatch(r, e.target.value)}
                  >
                    <option value="none">Nothing of mine</option>
                    {view.own_offers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {r.basis && <span className="cp-src cp-how">{BASIS[r.basis]}</span>}
                </td>
                <td className="num">
                  {r.yours?.price
                    ? moneyText(r.yours.price.amount_minor, r.yours.price.currency)
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
          Showing the first {rows.length} of {num(view.rows.length)} prices, matched ones first.
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
  return (
    <main className="screen cp-screen">
      <PageHead kicker="Insights · Competitors" title={title} aside={aside} />
      {children}
    </main>
  );
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? "That didn't work. Try again.";
  } catch {
    return "That didn't work. Try again.";
  }
}

export function CompetitorsScreen() {
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
    if (!res.ok) return errorOf(res);
    await load();
    return null;
  };

  const read = async (id: string) => {
    setReading(id);
    setNotice(null);
    const res = await fetch(`/api/competitors/${id}/read`, { method: "POST" });
    if (!res.ok) setNotice(await errorOf(res));
    setReading(null);
    await load();
  };

  const remove = async (id: string) => {
    const name = view?.competitors.find((c) => c.id === id)?.name ?? "this competitor";
    if (!window.confirm(`Stop watching ${name}? What I read about them stays in your history.`))
      return;
    const res = await fetch(`/api/competitors/${id}`, { method: "DELETE" });
    if (!res.ok) setNotice(await errorOf(res));
    await load();
  };

  const match = async (row: PriceRow, offerId: string | null) => {
    const res = await fetch(`/api/competitors/${row.competitor_id}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: row.key, offer_id: offerId }),
    });
    if (!res.ok) setNotice(await errorOf(res));
    await load();
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="cp-wait">
          <Link href="/intake">Start with the interview</Link>, and name your competitors there.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Competitors didn't load.">
        <p className="cp-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading what I know about your competitors…" />;

  return (
    <Frame title={headline(view)} aside={<>Public pages only · read weekly · OBSERVED</>}>
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
