"use client";

// Customers · Abandoned carts — idea 47, on the sheet system (app/sheet.css).
// The head is the measured fact: what was left in carts over the last 30
// days, and how many of the shoppers can be emailed. Then the products left
// behind, the likely-to-win-back range with its rule of thumb and sources,
// "Propose win-back emails" (off while watching, saying why), and the
// consent notes, every one a count. Read-only: proposing puts one email in
// the queue, nothing sends until the owner approves the email itself, and a
// shopper who hasn't said yes is never emailed (rule 19). Shown in the menu
// only when a store connection reads carts.

import "../../app/carts.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CartsScreenView } from "../../app/api/carts/route";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import type { Measured } from "./carts-view";
import {
  cartsHeadline,
  refusalTitle,
  consentNotes,
  moneyList,
  proposalWord,
  proposeBlock,
  sourcesLine,
  weekLine,
  winBackText,
  windowLine,
} from "./carts-view";

const FOOT =
  "SYB never emails a shopper who hasn't said yes. Shopify's own abandoned-checkout email, if you use it, is separate.";

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
    <main className="screen ct-screen">
      <PageHead kicker="Customers · Abandoned carts" title={title} aside={aside} />
      {children}
      <p className="ct-foot">{FOOT}</p>
    </main>
  );
}

function ProductsCard({ m, names }: { m: Measured; names: Record<string, string> }) {
  return (
    <SheetCard
      label={`What was left behind · ${num(m.current.left)} carts`}
      title={m.products.length > 0 ? "In the most carts first" : "No product to name"}
      meta="Measured from your shop's own checkouts"
    >
      {m.products.length > 0 ? (
        <div className="ct-table-wrap" tabIndex={0} aria-label="Products left in carts">
          <table className="rt rt-stack ct-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">
                  In carts
                </th>
                <th scope="col" className="num">
                  Units
                </th>
                <th scope="col" className="num">
                  Value left
                </th>
              </tr>
            </thead>
            <tbody>
              {m.products.map((p) => (
                <tr key={p.product_ref}>
                  <th scope="row">{names[p.product_ref] ?? p.title ?? "A product"}</th>
                  <td className="num" data-label="In carts">
                    {num(p.carts)}
                  </td>
                  <td className="num" data-label="Units">
                    {num(p.units)}
                  </td>
                  <td className="num" data-label="Value left">
                    {moneyList(p.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ct-copy">The carts left held no product I can name.</p>
      )}
      {m.truncated > 0 && (
        <p className="ct-copy ct-quiet">
          {num(m.truncated)} {m.truncated === 1 ? "cart had" : "carts had"} more items than one read
          takes, so only the first 15 of each are counted here. Their totals are counted in full.
        </p>
      )}
    </SheetCard>
  );
}

function WinBackCard({
  view,
  m,
  busy,
  note,
  onPropose,
}: {
  view: CartsScreenView;
  m: Measured;
  busy: boolean;
  note: string | null;
  onPropose: () => void;
}) {
  const range = winBackText(m);
  const rule = view.rule_of_thumb;
  const block = proposeBlock(view);
  const r = view.reminder;
  const t = view.thresholds;
  const word = view.proposal ? proposalWord(view.proposal) : null;
  return (
    <SheetCard
      label={`Likely to win back · ${num(m.reach.emailable_shoppers)} of ${num(m.reach.shoppers)} shoppers can be emailed`}
      title={range ? `${range} likely back` : "Nothing to win back by email yet"}
      meta={rule ? <span className="word boxed">{rule.label}</span> : undefined}
      foot={
        <span className="ct-foot-row">
          <span>
            {block ??
              (word
                ? "Today's reminder is in your queue."
                : `One email to the ${num(r?.emailable ?? 0)} ${r?.emailable === 1 ? "contact" : "contacts"} who left a cart ${t?.winback_min_days ?? 1}–${t?.winback_max_days ?? 7} days ago and said yes. Nothing sends until you approve the email itself.`)}
            {word && <span className={`word ${word.tone}`}>{word.word}</span>}
          </span>
          <button
            type="button"
            className="act"
            disabled={busy || block !== null || view.proposal !== null}
            onClick={onPropose}
          >
            {busy ? "Working it out…" : "Propose win-back emails →"}
          </button>
        </span>
      }
    >
      {range ? (
        <p className="ct-fig">
          {m.win_back
            .map(
              (w) =>
                `${Math.round((rule?.low ?? 0) * 100)}–${Math.round((rule?.high ?? 0) * 100)}% of ${moneyText(w.base_minor, w.currency)}`,
            )
            .join(" · ")}
          <span className="ct-src">
            the value of the {num(m.reach.carts.emailable)}{" "}
            {m.reach.carts.emailable === 1 ? "cart" : "carts"} whose shopper said yes to email
          </span>
        </p>
      ) : (
        <p className="ct-copy">
          Nobody who left a cart in the last {t?.window_days ?? 30} days can be emailed, so I put no
          figure on it.
        </p>
      )}
      <ul className="ct-assumed">
        {rule && <li>{rule.statement}</li>}
        <li>{sourcesLine(view)}</li>
      </ul>
      {view.proposal?.status === "blocked" && view.proposal.blocked_by_limit && (
        <p className="ct-copy ct-quiet">
          I didn&apos;t put this in your queue: your rule ({view.proposal.blocked_by_limit}) rules
          it out.
        </p>
      )}
      {busy && (
        <p className="ct-copy live">
          <span className="live-dot" aria-hidden="true" /> Working out the reminder
        </p>
      )}
      {note && (
        <p className="ct-copy">
          {note} <Link href="/proposals">Waiting for you</Link>
        </p>
      )}
    </SheetCard>
  );
}

function ConsentCard({ m, view }: { m: Measured; view: CartsScreenView }) {
  const notes = consentNotes(m, view.sources?.find((s) => s.shopper)?.shopper ?? null);
  const week = weekLine(view);
  return (
    <SheetCard label="Who can be emailed" title="Only people who said yes">
      <ul className="ct-notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {week && <p className="ct-copy ct-quiet">{week}</p>}
      <p className="ct-copy ct-quiet">
        Shopify&apos;s own &ldquo;email me&rdquo; tick at checkout isn&apos;t counted as a yes. Only
        what you recorded on your contacts is.
      </p>
    </SheetCard>
  );
}

export function CartsScreen() {
  const [view, setView] = useState<CartsScreenView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/carts");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as CartsScreenView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const propose = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/carts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose" }),
      });
      const body = (await res.json()) as {
        error?: string;
        created?: number;
        blocked?: number;
        skipped?: { reason: string }[];
      };
      if (!res.ok) setNote(body.error ?? "That didn't work.");
      else {
        const c = body.created ?? 0;
        const b = body.blocked ?? 0;
        setNote(
          c + b === 0
            ? `Nothing new to propose${body.skipped?.[0] ? `: ${body.skipped[0].reason}` : ""}.`
            : c > 0
              ? "A win-back email now waits for you."
              : "Your own rules blocked it, so it sits blocked in your queue.",
        );
        await load();
      }
    } catch {
      setNote("Something went wrong on our side.");
    } finally {
      setBusy(false);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="ct-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Carts didn't load.">
        <p className="ct-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your carts…" />;
  if (!view.applies) {
    return (
      <Frame title={cartsHeadline(view)}>
        <p className="ct-wait">
          Connect your Shopify shop and I read its unfinished checkouts with every sync.{" "}
          <Link href="/connections">Connections</Link>
        </p>
      </Frame>
    );
  }

  const m = view.measure;
  const aside = (
    <>
      {(view.sources ?? []).map((s) => s.label).join(" · ")} ·{" "}
      {m?.status === "measured" ? "MEASURED" : "NOT YET"}
    </>
  );

  if (!m || m.status === "refused") {
    return (
      <Frame title={cartsHeadline(view)} aside={aside}>
        <SheetCard label="Abandoned carts" title={refusalTitle(m)}>
          <p className="ct-copy">{m?.reason ?? "I haven't read any carts yet."}</p>
          {m?.basis === "stale" || m?.basis === "too_many" ? null : (
            <p className="ct-copy ct-quiet">
              I measure once there are {view.thresholds?.min_days ?? 14} days of carts and{" "}
              {view.thresholds?.min_carts ?? 10} carts left in the last{" "}
              {view.thresholds?.window_days ?? 30} days, so a quiet week isn&apos;t read as a
              pattern.
            </p>
          )}
          <p className="ct-copy ct-quiet">{sourcesLine(view)}</p>
        </SheetCard>
      </Frame>
    );
  }

  return (
    <Frame title={cartsHeadline(view)} aside={aside}>
      <p className="ct-line">{windowLine(m)}</p>
      <ProductsCard m={m} names={view.product_names ?? {}} />
      <div className="ct-grid">
        <WinBackCard view={view} m={m} busy={busy} note={note} onPropose={() => void propose()} />
        <ConsentCard m={m} view={view} />
      </div>
    </Frame>
  );
}
