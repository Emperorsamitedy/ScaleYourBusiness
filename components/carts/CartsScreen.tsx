"use client";

// Customers · Abandoned carts — idea 47, on the sheet system (app/sheet.css).
// The head is the measured fact: what was left in carts over the last 30
// days, and how many of the shoppers can be emailed. Then the products left
// behind, the likely-to-win-back range with its rule of thumb and sources,
// "Propose win-back emails" (off while watching, saying why), and the
// consent notes, every one a count. Read-only: proposing puts one email in
// the queue, nothing sends until the owner approves the email itself, and a
// shopper who hasn't said yes is never emailed (rule 19). Shown in the menu
// only when a store connection reads carts. The rule of thumb, the sources
// and the consent notices sit folded under "How this works" (decluttered
// 2026-11-09 on the owner's instruction).
//
// L-3b: the screen's fixed words are the "carts" catalogue; money, counts
// and shares in the reader's locale. L-4b: the sentences carts-view builds
// from the counts are the "cartsWords" catalogue, and the server words the
// rule of thumb and the reasons in the reader's language too.

import "../../app/carts.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { CartsScreenView } from "../../app/api/carts/route";
import { percentText } from "../cash/cash-view";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { CartsSentences, CartsWords, Measured } from "./carts-view";
import {
  cartsHeadline,
  checkoutConsentNotes,
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

/** How many of a cart's items one read takes (SHOPIFY_CART_LINES, lib/connectors/providers/shopify.ts). */
const ITEMS_PER_READ = 15;

function useCartsWords(): CartsWords {
  return useTr("carts");
}

/** L-4b: the sentences carts-view builds, in the reader's language. */
function useCartsSentences(): CartsSentences {
  return useTr("cartsWords");
}

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useCartsWords();
  return (
    <main className="screen ct-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
      <Fold summary={tr("how")}>
        <p className="ct-foot">{tr("foot")}</p>
      </Fold>
    </main>
  );
}

function ProductsCard({ m, names }: { m: Measured; names: Record<string, string> }) {
  const words = useCartsWords();
  const { tr, locale } = words;
  return (
    <SheetCard
      label={tr("products.label", { count: m.current.left })}
      title={m.products.length > 0 ? undefined : tr("products.titleNone")}
    >
      {m.products.length > 0 ? (
        <div className="ct-table-wrap" tabIndex={0} aria-label={tr("products.table")}>
          <table className="rt rt-stack ct-table">
            <thead>
              <tr>
                <th scope="col">{tr("products.product")}</th>
                <th scope="col" className="num">
                  {tr("products.inCarts")}
                </th>
                <th scope="col" className="num">
                  {tr("products.units")}
                </th>
                <th scope="col" className="num">
                  {tr("products.valueLeft")}
                </th>
              </tr>
            </thead>
            <tbody>
              {m.products.map((p) => (
                <tr key={p.product_ref}>
                  <th scope="row">{names[p.product_ref] ?? p.title ?? tr("products.aProduct")}</th>
                  <td className="num" data-label={tr("products.inCarts")}>
                    {num(p.carts, 0, locale)}
                  </td>
                  <td className="num" data-label={tr("products.units")}>
                    {num(p.units, 0, locale)}
                  </td>
                  <td className="num" data-label={tr("products.valueLeft")}>
                    {moneyList(p.value, words)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ct-copy">{tr("products.noProduct")}</p>
      )}
      {m.truncated > 0 && (
        <p className="ct-copy ct-quiet">
          {tr("products.truncated", {
            count: m.truncated,
            max: num(ITEMS_PER_READ, 0, locale),
          })}
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
  const words = useCartsWords();
  const sentences = useCartsSentences();
  const { tr, locale } = words;
  const range = winBackText(m, words);
  const rule = view.rule_of_thumb;
  const block = proposeBlock(view, sentences);
  const r = view.reminder;
  const t = view.thresholds;
  const word = view.proposal ? proposalWord(view.proposal, tr) : null;
  return (
    <SheetCard
      label={tr("winBack.label", {
        emailable: num(m.reach.emailable_shoppers, 0, locale),
        shoppers: num(m.reach.shoppers, 0, locale),
      })}
      title={range ? tr("winBack.titleRange", { range }) : tr("winBack.titleNone")}
      meta={rule ? <span className="word boxed">{rule.label}</span> : undefined}
      foot={
        <span className="ct-foot-row">
          <span>
            {block ??
              (word
                ? tr("winBack.inQueue")
                : tr("winBack.oneEmail", {
                    count: r?.emailable ?? 0,
                    min: num(t?.winback_min_days ?? 1, 0, locale),
                    max: num(t?.winback_max_days ?? 7, 0, locale),
                  }))}
            {word && <span className={`word ${word.tone}`}>{word.word}</span>}
          </span>
          <button
            type="button"
            className="act"
            disabled={busy || block !== null || view.proposal !== null}
            onClick={onPropose}
          >
            {busy ? tr("workingItOut") : tr("winBack.button")}
          </button>
        </span>
      }
    >
      {range ? (
        <p className="ct-fig">
          {m.win_back
            .map((w) =>
              tr("winBack.rangeOf", {
                low: num(Math.round((rule?.low ?? 0) * 100), 0, locale),
                high: percentText(Math.round((rule?.high ?? 0) * 100), locale),
                base: moneyText(w.base_minor, w.currency, locale),
              }),
            )
            .join(" · ")}
          <span className="ct-src">
            {tr("winBack.rangeBase", { count: m.reach.carts.emailable })}
          </span>
        </p>
      ) : (
        <p className="ct-copy">
          {tr("winBack.nobody", { days: num(t?.window_days ?? 30, 0, locale) })}
        </p>
      )}
      <Fold summary={tr("how")}>
        <ul className="ct-assumed">
          {rule && <li>{rule.statement}</li>}
          <li>{sourcesLine(view, sentences)}</li>
        </ul>
      </Fold>
      {view.proposal?.status === "blocked" && view.proposal.blocked_by_limit && (
        <p className="ct-copy ct-quiet">
          {tr("ruledOut", { rule: view.proposal.blocked_by_limit })}
        </p>
      )}
      {busy && (
        <p className="ct-copy live">
          <span className="live-dot" aria-hidden="true" /> {tr("winBack.working")}
        </p>
      )}
      {note && (
        <p className="ct-copy">
          {note} <Link href="/proposals">{tr("waitingForYou")}</Link>
        </p>
      )}
    </SheetCard>
  );
}

function ConsentCard({ m, view }: { m: Measured; view: CartsScreenView }) {
  const sentences = useCartsSentences();
  const notes = consentNotes(m, view.sources?.find((s) => s.shopper)?.shopper ?? null, sentences);
  const checkout = checkoutConsentNotes(view, sentences);
  const week = weekLine(view, sentences);
  const { tr } = useCartsWords();
  return (
    <SheetCard title={tr("consent.label")}>
      <ul className="ct-notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {week && <p className="ct-copy ct-quiet">{week}</p>}
      {checkout.length > 0 ? (
        <ul className="ct-notes">
          {checkout.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <Fold summary={tr("how")}>
        <p className="ct-copy ct-quiet">{tr("consent.checkout")}</p>
      </Fold>
    </SheetCard>
  );
}

export function CartsScreen() {
  const { tr, locale } = useCartsWords();
  const sentences = useCartsSentences();
  const rich = useTranslations("carts");
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
      if (!res.ok) setNote(body.error ?? tr("result.didntWork"));
      else {
        const c = body.created ?? 0;
        const b = body.blocked ?? 0;
        const why = body.skipped?.[0]?.reason;
        setNote(
          c + b === 0
            ? why
              ? tr("result.nothingNewWhy", { reason: why })
              : tr("result.nothingNew")
            : c > 0
              ? tr("result.waits")
              : tr("result.blocked"),
        );
        await load();
      }
    } catch {
      setNote(tr("result.ourSide"));
    } finally {
      setBusy(false);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut")}>
        <p className="ct-wait">
          {rich.rich("startInterview", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("failedTitle")}>
        <p className="ct-wait">{tr("failedBody")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("reading")} />;
  if (!view.applies) {
    return (
      <Frame title={cartsHeadline(view, sentences)}>
        <p className="ct-wait">
          {tr("connect")} <Link href="/connections">{tr("connections")}</Link>
        </p>
      </Frame>
    );
  }

  const m = view.measure;
  const aside = (
    <>
      {(view.sources ?? []).map((s) => s.label).join(" · ")} ·{" "}
      {m?.status === "measured" ? tr("measured") : tr("notYet")}
    </>
  );

  if (!m || m.status === "refused") {
    return (
      <Frame title={cartsHeadline(view, sentences)} aside={aside}>
        <SheetCard title={refusalTitle(m, tr)}>
          <p className="ct-copy">{m?.reason ?? tr("refusal.noneRead")}</p>
          <Fold summary={tr("why")}>
            {m?.basis === "stale" || m?.basis === "too_many" ? null : (
              <p className="ct-copy ct-quiet">
                {tr("refusal.rule", {
                  days: num(view.thresholds?.min_days ?? 14, 0, locale),
                  carts: num(view.thresholds?.min_carts ?? 10, 0, locale),
                  window: num(view.thresholds?.window_days ?? 30, 0, locale),
                })}
              </p>
            )}
            <p className="ct-copy ct-quiet">{sourcesLine(view, sentences)}</p>
          </Fold>
        </SheetCard>
      </Frame>
    );
  }

  return (
    <Frame title={cartsHeadline(view, sentences)} aside={aside}>
      <p className="ct-line">{windowLine(m, sentences)}</p>
      <ProductsCard m={m} names={view.product_names ?? {}} />
      <div className="ct-grid">
        <WinBackCard view={view} m={m} busy={busy} note={note} onPropose={() => void propose()} />
        <ConsentCard m={m} view={view} />
      </div>
    </Frame>
  );
}
