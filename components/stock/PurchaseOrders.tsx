"use client";

// Purchase orders on /stock — P6-04 (rule 27 amended). For each supplier
// whose items are running low, a form: the lines with the suggested
// quantities and their arithmetic (rule 6), the supplier's email (asked for
// when it isn't on file, and kept with the supplier as a stated fact), the
// delivery address and a note. Submitting puts the order in the approval
// queue; nothing goes out until the owner approves it (rule 12). Below, the
// orders made: where each stands, "Send now" for an approved one (through
// the engine), "Mark as sent by hand", and the order as a PDF (P6-09) or a
// page to download or print. When email can't really go out yet, the card
// says so before anything is made, and an approved order is HELD, not done
// (2026-11-09): it says why and that it goes out on its own once sending is
// on — or, approved more than 14 days before, that it waits for a yes again.
// A line without a stated or measured price reads "to be confirmed by the
// supplier" (decision 4).
//
// Said plainly on 2026-11-28 (the canvas design the owner approved): the
// form sits inside the screen's one "Order now" card, beside the items it
// orders. Each line shows its quantity and price, the plain why beneath it
// (from the screen), the supplier's working one press away; the note to the
// supplier folds. The orders made list under the card, as before.

import { useState } from "react";
import Link from "next/link";
import type { PoBlock, PoDraftView } from "../../app/api/stock/route";
import { Fold } from "../sheet/Fold";
import { moneyText } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { PO_APPROVAL_MAX_AGE_DAYS } from "../../lib/execution/stale";
import { notSentWords, orderState, totalsText, unitPriceText, waitingWords } from "./po-view";
import type { PoWords } from "./po-view";

export function DraftForm({
  draft,
  held,
  sending,
  whys,
  onMade,
}: {
  draft: PoDraftView;
  held: string | null;
  sending: PoBlock["sending"];
  /** The plain why per line key, worded by the screen (stock-view plainWhy). */
  whys: ReadonlyMap<string, string>;
  onMade: () => Promise<void>;
}) {
  const w: PoWords = useTr("stock");
  const { tr, locale } = w;
  const [email, setEmail] = useState(draft.email ?? "");
  const [address, setAddress] = useState(draft.address ?? "");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(draft.lines.map((l) => [l.key, String(l.suggested)])),
  );
  const [include, setInclude] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(draft.lines.map((l) => [l.key, true])),
  );
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; made: boolean } | null>(null);
  const chosen = draft.lines.filter((l) => include[l.key]);
  const blocked = held !== null || draft.open !== null;
  const several = draft.lines.length > 1;
  // The order's cost at the quantities typed, when every chosen line has a price in one currency (rule 1).
  const currencies = new Set(chosen.map((l) => l.unit_cost?.currency ?? null));
  const total =
    chosen.length > 0 && !currencies.has(null) && currencies.size === 1
      ? {
          amount_minor: chosen.reduce(
            (sum, l) =>
              sum +
              Math.max(0, Math.round(Number(qty[l.key]) || 0)) * (l.unit_cost?.amount_minor ?? 0),
            0,
          ),
          currency: chosen[0]?.unit_cost?.currency ?? "",
        }
      : null;

  const submit = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "purchase_order",
          supplier_id: draft.supplier.id,
          email,
          delivery_address: address,
          note,
          include: chosen.map((l) => l.key),
          quantities: Object.fromEntries(chosen.map((l) => [l.key, qty[l.key] ?? ""])),
        }),
      });
      const body = (await res.json()) as { error?: string; number?: string | null };
      if (!res.ok) {
        setSaid({ text: body.error ?? tr("result.didntWork"), made: false });
        return;
      }
      setSaid({ text: tr("po.made", { number: body.number ?? "" }), made: true });
      await onMade();
    } catch {
      setSaid({ text: tr("result.ourSide"), made: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-po">
      <p className="st-po-k">{tr("order.suggested", { supplier: draft.supplier.name })}</p>
      {draft.open && (
        <p className="st-copy">
          {tr("po.open", { number: draft.open.number, state: tr(`po.state.${draft.open.status}`) })}{" "}
          {draft.open.status === "pending" && <Link href="/proposals">{tr("waitingForYou")}</Link>}
        </p>
      )}
      <ul className="st-po-lines">
        {draft.lines.map((l) => (
          <li key={l.key}>
            <div className="st-po-line">
              {several && (
                <input
                  type="checkbox"
                  aria-label={l.name}
                  checked={include[l.key] ?? false}
                  disabled={busy || blocked}
                  onChange={(e) => setInclude({ ...include, [l.key]: e.target.checked })}
                />
              )}
              <span className="st-po-name">{l.name}</span>
              <input
                className="st-qty"
                inputMode="numeric"
                aria-label={`${tr("po.col.quantity")}: ${l.name}`}
                value={qty[l.key] ?? ""}
                disabled={busy || blocked || !include[l.key]}
                onChange={(e) => setQty({ ...qty, [l.key]: e.target.value })}
              />
              <span className="st-po-unit">
                {tr("order.each", { price: unitPriceText(l.unit_cost, w) })}
              </span>
            </div>
            {whys.get(l.key) && <p className="st-why">{whys.get(l.key)}</p>}
          </li>
        ))}
      </ul>
      {total && (
        <p className="st-po-total">
          {tr("order.total", { amount: moneyText(total.amount_minor, total.currency, locale) })}
        </p>
      )}
      <label className="st-field">
        <span className="label">{tr("order.email", { supplier: draft.supplier.name })}</span>
        <input
          type="email"
          autoComplete="off"
          value={email}
          disabled={busy || blocked}
          onChange={(e) => setEmail(e.target.value)}
        />
        <span className="st-src">{draft.email ? tr("po.emailOnFile") : tr("po.emailAsk")}</span>
      </label>
      <label className="st-field">
        <span className="label">{tr("po.address")}</span>
        <textarea
          rows={2}
          value={address}
          disabled={busy || blocked}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <Fold summary={tr("order.noteFold")}>
        <label className="st-field">
          <span className="label">{tr("po.note")}</span>
          <textarea
            rows={2}
            value={note}
            disabled={busy || blocked}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </Fold>
      <button
        type="button"
        className="act st-po-go"
        disabled={
          busy || blocked || chosen.length === 0 || email.trim() === "" || address.trim() === ""
        }
        onClick={() => void submit()}
      >
        {busy ? tr("po.working") : tr("order.button")}
      </button>
      {said && (
        <p className="st-copy">
          {said.text} {said.made && <Link href="/proposals">{tr("waitingForYou")}</Link>}
        </p>
      )}
      <p className="st-why">
        {tr("order.after")}{" "}
        {sending.real
          ? tr("order.sendReal", { supplier: draft.supplier.name })
          : tr("order.sendHeld")}
      </p>
      <Fold label="why">
        {draft.lines.map((l) => (
          <p key={l.key} className="st-rank-math">
            {l.arithmetic}
          </p>
        ))}
        {!sending.real && <p className="st-rank-math">{notSentWords(sending.reasons, w)}</p>}
      </Fold>
    </div>
  );
}

export function Orders({ block, onChange }: { block: PoBlock; onChange: () => Promise<void> }) {
  const w: PoWords = useTr("stock");
  const { tr, locale } = w;
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; text: string } | null>(null);

  const act = async (id: string, action: "po_send" | "po_sent_by_hand") => {
    setBusy(`${action}:${id}`);
    setSaid(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const body = (await res.json()) as {
        error?: string;
        result?: "sent" | "held" | "not_sent" | "refused" | "failed" | "sent_by_hand";
        reasons?: ("email_not_set_up" | "real_writes_off")[];
        message?: string;
      };
      const text = !res.ok
        ? (body.error ?? tr("result.didntWork"))
        : body.result === "sent"
          ? tr("po.result.sent")
          : body.result === "sent_by_hand"
            ? tr("po.result.byHand")
            : body.result === "held"
              ? `${tr("po.result.held")} ${notSentWords(body.reasons ?? [], w)} ${tr("po.heldAfter")}`
              : body.result === "not_sent"
                ? `${tr("po.result.notSent")} ${notSentWords(body.reasons ?? [], w)}`
                : (body.message ?? tr("result.didntWork"));
      setSaid({ id, text });
      await onChange();
    } catch {
      setSaid({ id, text: tr("result.ourSide") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-table-wrap" tabIndex={0} aria-label={tr("po.list")}>
      <table className="rt rt-stack st-table">
        <thead>
          <tr>
            <th scope="col">{tr("po.list")}</th>
            <th scope="col" className="num">
              {tr("po.col.items")}
            </th>
            <th scope="col" className="num">
              {tr("po.col.total")}
            </th>
            <th scope="col">{tr("po.col.state")}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {block.orders.map((o) => {
            const state = orderState(o, w);
            const waiting = waitingWords(o, PO_APPROVAL_MAX_AGE_DAYS, w);
            return (
              <tr key={o.id}>
                <th scope="row">
                  {o.number}
                  <span className="st-src">{o.supplier}</span>
                </th>
                <td className="num" data-label={tr("po.col.items")}>
                  {tr("po.items", { count: o.lines })}
                </td>
                <td className="num" data-label={tr("po.col.total")}>
                  {totalsText(o.totals, locale)}
                </td>
                <td data-label={tr("po.col.state")}>
                  <span className={`word ${state.tone}`}>{state.word}</span>
                  {o.sent === false && (
                    <span className="st-src">
                      {notSentWords(o.not_sent, w)} {tr("po.notSentAfter")}
                    </span>
                  )}
                  {waiting && <span className="st-src">{waiting}</span>}
                  {o.error && o.sent === null && <span className="st-src">{o.error}</span>}
                  {o.status === "blocked" && o.blocked_by_limit && (
                    <span className="st-src">{tr("ruledOut", { rule: o.blocked_by_limit })}</span>
                  )}
                  {said?.id === o.id && <span className="st-src">{said.text}</span>}
                </td>
                <td>
                  <span className="st-po-acts">
                    {o.status === "approved" && (
                      <button
                        type="button"
                        className="act"
                        disabled={busy !== null}
                        onClick={() => void act(o.id, "po_send")}
                      >
                        {busy === `po_send:${o.id}` ? tr("po.sendingNow") : tr("po.sendNow")}
                      </button>
                    )}
                    {o.status === "approved" && (
                      <button
                        type="button"
                        className="act"
                        disabled={busy !== null}
                        onClick={() => void act(o.id, "po_sent_by_hand")}
                      >
                        {busy === `po_sent_by_hand:${o.id}`
                          ? tr("po.markingByHand")
                          : tr("po.markByHand")}
                      </button>
                    )}
                    <a href={`/api/stock/po/${o.id}?format=pdf`} download={`${o.number}.pdf`}>
                      {tr("po.downloadPdf")}
                    </a>
                    <a href={`/api/stock/po/${o.id}?download=1`} download={`${o.number}.html`}>
                      {tr("po.download")}
                    </a>
                    <a href={`/api/stock/po/${o.id}`} target="_blank" rel="noopener noreferrer">
                      {tr("po.print")}
                    </a>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
