"use client";

// Purchase orders on /stock — P6-04 (rule 27 amended). For each supplier
// whose items are running low, a form: the lines with the suggested
// quantities and their arithmetic (rule 6), the supplier's email (asked for
// when it isn't on file, and kept with the supplier as a stated fact), the
// delivery address and a note. Submitting puts the order in the approval
// queue; nothing goes out until the owner approves it (rule 12). Below, the
// orders made: where each stands, "Send now" for an approved one (through
// the engine), and the order as a PDF (P6-09) or a page to download or
// print. When email
// can't really go out yet, the card says so before anything is made, and an
// order that ran against the fake sender says "ready, not sent" and why.

import { useState } from "react";
import Link from "next/link";
import type { PoBlock, PoDraftView } from "../../app/api/stock/route";
import { num } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import { notSentWords, orderState, totalsText } from "./po-view";
import type { PoWords } from "./po-view";

function DraftForm({
  draft,
  held,
  onMade,
}: {
  draft: PoDraftView;
  held: string | null;
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
      <p className="st-rank-head">
        <strong>{draft.supplier.name}</strong>
      </p>
      {draft.open && (
        <p className="st-copy">
          {tr("po.open", { number: draft.open.number, state: tr(`po.state.${draft.open.status}`) })}{" "}
          {draft.open.status === "pending" && <Link href="/proposals">{tr("waitingForYou")}</Link>}
        </p>
      )}
      <div className="st-table-wrap" tabIndex={0} aria-label={draft.supplier.name}>
        <table className="rt rt-stack st-table">
          <thead>
            <tr>
              <th scope="col">{tr("po.col.order")}</th>
              <th scope="col">{tr("po.col.item")}</th>
              <th scope="col" className="num">
                {tr("po.col.suggested")}
              </th>
              <th scope="col" className="num">
                {tr("po.col.quantity")}
              </th>
              <th scope="col" className="num">
                {tr("po.col.unit")}
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l) => (
              <tr key={l.key}>
                <td data-label={tr("po.col.order")}>
                  <input
                    type="checkbox"
                    aria-label={l.name}
                    checked={include[l.key] ?? false}
                    disabled={busy || blocked}
                    onChange={(e) => setInclude({ ...include, [l.key]: e.target.checked })}
                  />
                </td>
                <th scope="row">
                  {l.name}
                  <span className="st-src">{l.arithmetic}</span>
                </th>
                <td className="num" data-label={tr("po.col.suggested")}>
                  {num(l.suggested, 0, locale)}
                </td>
                <td className="num" data-label={tr("po.col.quantity")}>
                  <input
                    className="st-qty"
                    inputMode="numeric"
                    aria-label={`${tr("po.col.quantity")}: ${l.name}`}
                    value={qty[l.key] ?? ""}
                    disabled={busy || blocked || !include[l.key]}
                    onChange={(e) => setQty({ ...qty, [l.key]: e.target.value })}
                  />
                </td>
                <td className="num" data-label={tr("po.col.unit")}>
                  {l.unit_cost ? totalsText([l.unit_cost], locale) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="st-form">
        <label className="st-field">
          <span className="label">{tr("po.email")}</span>
          <input
            type="email"
            autoComplete="off"
            value={email}
            disabled={busy || blocked}
            onChange={(e) => setEmail(e.target.value)}
          />
          <span className="st-src">{draft.email ? tr("po.emailOnFile") : tr("po.emailAsk")}</span>
        </label>
        <label className="st-field st-wide">
          <span className="label">{tr("po.address")}</span>
          <textarea
            rows={3}
            value={address}
            disabled={busy || blocked}
            onChange={(e) => setAddress(e.target.value)}
          />
          {draft.address && <span className="st-src">{tr("po.addressOnFile")}</span>}
        </label>
        <label className="st-field st-wide">
          <span className="label">{tr("po.note")}</span>
          <textarea
            rows={2}
            value={note}
            disabled={busy || blocked}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="act"
          disabled={
            busy || blocked || chosen.length === 0 || email.trim() === "" || address.trim() === ""
          }
          onClick={() => void submit()}
        >
          {busy ? tr("po.working") : tr("po.button")}
        </button>
      </div>
      {said && (
        <p className="st-copy">
          {said.text} {said.made && <Link href="/proposals">{tr("waitingForYou")}</Link>}
        </p>
      )}
    </div>
  );
}

function Orders({ block, onChange }: { block: PoBlock; onChange: () => Promise<void> }) {
  const w: PoWords = useTr("stock");
  const { tr, locale } = w;
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; text: string } | null>(null);

  const sendNow = async (id: string) => {
    setBusy(id);
    setSaid(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "po_send", id }),
      });
      const body = (await res.json()) as {
        error?: string;
        result?: "sent" | "not_sent" | "refused" | "failed";
        reasons?: ("email_not_set_up" | "real_writes_off")[];
        message?: string;
      };
      const text = !res.ok
        ? (body.error ?? tr("result.didntWork"))
        : body.result === "sent"
          ? tr("po.result.sent")
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
                        onClick={() => void sendNow(o.id)}
                      >
                        {busy === o.id ? tr("po.sendingNow") : tr("po.sendNow")}
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

export function PurchaseOrdersCard({
  block,
  onChange,
}: {
  block: PoBlock;
  onChange: () => Promise<void>;
}) {
  const w: PoWords = useTr("stock");
  const { tr } = w;
  return (
    <SheetCard
      label={tr("po.label")}
      title={tr("po.title")}
      meta={tr("po.meta")}
      foot={
        block.sending.real
          ? tr("po.sendingReal")
          : `${tr("po.sendingFake")} ${notSentWords(block.sending.reasons, w)}`
      }
    >
      <p className="st-copy">{tr("po.intro")}</p>
      {block.held && <p className="st-copy">{block.held}</p>}
      {block.drafts.map((d) => (
        <DraftForm key={d.supplier.id} draft={d} held={block.held} onMade={onChange} />
      ))}
      {block.unsupplied.length > 0 && (
        <p className="st-copy">
          {tr("po.unsupplied", { items: block.unsupplied.join(", ") })}{" "}
          <Link href="/profile">{tr("factSheet")}</Link>
        </p>
      )}
      {block.orders.length > 0 && <Orders block={block} onChange={onChange} />}
    </SheetCard>
  );
}
