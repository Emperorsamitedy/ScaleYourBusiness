"use client";

// Insights · Payments — P6-05 (rule 26 amended: money is prepared, never
// moved), on the sheet system (app/sheet.css). The owner prepares a
// payment; it goes to the approval queue (rule 12); approved, it is ready
// for the bank: a SEPA file for euros and plain steps for any currency,
// both downloaded here and taken to the owner's own bank. The owner then
// says "paid in my bank". SYB never pays anything, and the screen says so.
//
// The owner's decisions of 2026-11-09: a NEW file holds only payments in no
// file yet, and each payment says which file it is in and when; a file made
// before can be downloaded again (the same file, the same message id, which
// a bank refuses twice) only past a plain warning. The screen is the owner's
// alone: a manager or a viewer reads the role refusal.
//
// IBANs reach this screen masked. The full numbers are only in the files,
// which are the owner's to download.
//
// L-3b: the fixed words are the "payments" catalogue; figures in the
// reader's locale.

import "../../app/payments.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { PaymentRow, PaymentsView } from "../../app/api/payments/route";
import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { ExportListing } from "../../lib/payments/exports";
import {
  amountToMinor,
  fileTotalMinor,
  fileWord,
  groupPayments,
  inFileWord,
  moneyText,
  newFileRows,
  refusalWords,
  stageWord,
} from "./payments-view";

type Act = (body: Record<string, unknown>, done: string) => void;
type Download = (format: "sepa" | "steps", count: number) => void;

function Frame({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const { tr } = useTr("payments");
  return (
    <main className="screen py-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={tr("never")} />
      {children}
    </main>
  );
}

function dateText(iso: string, locale: AppLocale): string {
  try {
    return dayMonthYear(iso, locale);
  } catch {
    return iso;
  }
}

function ReadyCard({
  view,
  rows,
  act,
  download,
  busy,
}: {
  view: PaymentsView;
  rows: PaymentRow[];
  act: Act;
  download: Download;
  busy: boolean;
}) {
  const { tr, locale } = useTr("payments");
  // Only payments in no file yet go in a new one (the owner's decision of 2026-11-09).
  const inFile = newFileRows(rows, "sepa");
  const forSteps = newFileRows(rows, "steps");
  const total = fileTotalMinor(rows);
  return (
    <SheetCard
      label={tr("ready.label")}
      title={rows.length === 0 ? tr("ready.none") : tr("ready.title", { count: rows.length })}
      foot={tr("ready.foot")}
    >
      {rows.length > 0 && (
        <div className="py-table-wrap" tabIndex={0} aria-label={tr("ready.label")}>
          <table className="rt rt-stack py-table">
            <thead>
              <tr>
                <th scope="col">{tr("col.payee")}</th>
                <th scope="col">{tr("col.iban")}</th>
                <th scope="col" className="num">
                  {tr("col.amount")}
                </th>
                <th scope="col">{tr("col.reference")}</th>
                <th scope="col">{tr("col.date")}</th>
                <th scope="col">{tr("col.file")}</th>
                <th scope="col">{tr("col.exported")}</th>
                <th scope="col">
                  <span className="py-sr">{tr("col.action")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.payee_name ?? tr("erased")}</th>
                  <td className="py-mono" data-label={tr("col.iban")}>
                    {r.iban_masked || "—"}
                  </td>
                  <td className="num" data-label={tr("col.amount")}>
                    {moneyText(r.amount, locale)}
                  </td>
                  <td data-label={tr("col.reference")}>{r.reference}</td>
                  <td data-label={tr("col.date")}>{dateText(r.execution_date, locale)}</td>
                  <td data-label={tr("col.file")}>{fileWord(r, tr)}</td>
                  <td data-label={tr("col.exported")}>
                    {inFileWord(r, tr, (iso) => dateText(iso, locale))}
                  </td>
                  <td data-label={tr("col.action")}>
                    {view.can_prepare && (
                      <button
                        type="button"
                        className="act"
                        disabled={busy}
                        onClick={() =>
                          act({ action: "mark_paid", payment_id: r.id }, tr("paid.done"))
                        }
                      >
                        {tr("paid.button")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && view.can_prepare && forSteps.length === 0 && (
        <p className="py-fine py-downloads">{tr("download.allInFile")}</p>
      )}
      {forSteps.length > 0 && view.can_prepare && (
        <div className="py-downloads">
          {inFile.length > 0 && view.payer !== null ? (
            <button
              type="button"
              className="act solid"
              disabled={busy}
              onClick={() => download("sepa", inFile.length)}
            >
              {tr("download.newSepa", { count: inFile.length })}
            </button>
          ) : (
            <p className="py-fine">
              {view.payer === null ? tr("download.needPayer") : tr("download.noneForFile")}
            </p>
          )}
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() => download("steps", forSteps.length)}
          >
            {tr("download.newSteps", { count: forSteps.length })}
          </button>
          <p className="py-fine">{tr("download.onlyNew")}</p>
          {inFile.length > 0 && view.payer !== null && (
            <p className="py-fine">
              {tr("download.total", {
                count: inFile.length,
                total: moneyText({ amount_minor: total, currency: "EUR" }, locale),
              })}
            </p>
          )}
        </div>
      )}
      {inFile.length > 0 && view.payer !== null && (
        <div className="py-steps">
          <p className="cs-label">{tr("steps.fileTitle")}</p>
          <ol>
            <li>{tr("steps.file.save", { file: tr("steps.fileName") })}</li>
            <li>{tr("steps.file.find")}</li>
            <li>{tr("steps.file.upload", { count: inFile.length })}</li>
            <li>{tr("steps.file.confirm")}</li>
            <li>{tr("steps.file.mark")}</li>
          </ol>
        </div>
      )}
    </SheetCard>
  );
}

/**
 * The files already downloaded (the owner's decision of 2026-11-09). Each
 * can be downloaded again — the same file, the same message id — but only
 * after a plain warning that uploading or paying it twice pays twice.
 */
function FilesCard({ files }: { files: ExportListing[] }) {
  const { tr, locale } = useTr("payments");
  if (files.length === 0) return null;
  return (
    <SheetCard
      label={tr("files.label")}
      title={tr("files.title", { count: files.length })}
      foot={tr("files.foot")}
    >
      <ul className="py-list">
        {files.map((f) => {
          const date = dateText(f.made_on, locale);
          return (
            <li key={f.id}>
              <span className="py-who">{tr(`files.${f.format}`, { date })}</span>{" "}
              <span className="py-mono">{f.msg_id}</span>{" "}
              <span className="py-fine">
                {tr("files.count", { count: f.count })}
                {" · "}
                {tr("files.paid", { count: f.paid })}
                {f.by && (
                  <>
                    {" · "}
                    {tr("files.by", { name: f.by })}
                  </>
                )}
              </span>
              {f.again ? (
                <details className="py-again">
                  <summary>{tr("files.again")}</summary>
                  <p className="py-warn" role="note">
                    {tr("files.warn", { date })}
                  </p>
                  {f.format === "sepa" && (
                    <p className="py-fine">{tr("files.sameId", { id: f.msg_id })}</p>
                  )}
                  <a className="act" href={`/api/payments/file?batch=${f.id}`} download>
                    {tr("files.confirm")}
                  </a>
                </details>
              ) : (
                <p className="py-fine">{tr("files.erased")}</p>
              )}
            </li>
          );
        })}
      </ul>
    </SheetCard>
  );
}

function WaitingCard({ rows }: { rows: PaymentRow[] }) {
  const { tr, locale } = useTr("payments");
  if (rows.length === 0) return null;
  return (
    <SheetCard label={tr("waiting.label")} title={tr("waiting.title", { count: rows.length })}>
      <ul className="py-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="py-who">{r.payee_name ?? tr("erased")}</span>{" "}
            <span className="py-mono">{moneyText(r.amount, locale)}</span>{" "}
            <span className="flag">{stageWord(r, tr)}</span>{" "}
            {r.blocked_by_limit && <span className="py-fine">{r.blocked_by_limit} </span>}
            <Link href={`/proposals/${r.proposal_id}`}>{tr("waiting.open")}</Link>
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

function ClosedCard({
  rows,
  act,
  busy,
  canPrepare,
}: {
  rows: PaymentRow[];
  act: Act;
  busy: boolean;
  canPrepare: boolean;
}) {
  const { tr, locale } = useTr("payments");
  if (rows.length === 0) return null;
  return (
    <SheetCard label={tr("closed.label")} title={tr("closed.title")} foot={tr("closed.foot")}>
      <ul className="py-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="py-who">{r.payee_name ?? tr("erased")}</span>{" "}
            <span className="py-mono">{moneyText(r.amount, locale)}</span>{" "}
            <span className="flag">{stageWord(r, tr)}</span>
            {r.paid_stated_at && (
              <span className="py-fine">
                {" "}
                {tr("paid.on", { date: dateText(r.paid_stated_at.slice(0, 10), locale) })}
              </span>
            )}
            {canPrepare && !r.erased && (
              <button
                type="button"
                className="py-link"
                disabled={busy}
                onClick={() => act({ action: "erase", payment_id: r.id }, tr("erase.done"))}
              >
                {tr("erase.button")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

function PayerCard({ view, act, busy }: { view: PaymentsView; act: Act; busy: boolean }) {
  const { tr } = useTr("payments");
  const [holder, setHolder] = useState("");
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");
  const [open, setOpen] = useState(view.payer === null);
  return (
    <SheetCard
      label={tr("payer.label")}
      title={view.payer ? view.payer.holder_name : tr("payer.none")}
      meta={view.payer ? <span className="py-mono">{view.payer.iban_masked}</span> : undefined}
      foot={tr("payer.foot")}
    >
      {!open && view.can_prepare && (
        <button type="button" className="act" onClick={() => setOpen(true)}>
          {tr("payer.change")}
        </button>
      )}
      {open && view.can_prepare && (
        <form
          className="py-form"
          onSubmit={(e) => {
            e.preventDefault();
            act({ action: "state_payer", holder_name: holder, iban, bic }, tr("payer.done"));
            setIban("");
          }}
        >
          <label className="py-field">
            <span className="label">{tr("payer.holder")}</span>
            <input value={holder} onChange={(e) => setHolder(e.target.value)} autoComplete="off" />
          </label>
          <label className="py-field">
            <span className="label">{tr("form.iban")}</span>
            <input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="py-field">
            <span className="label">{tr("form.bic")}</span>
            <input
              value={bic}
              onChange={(e) => setBic(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="py-wide">
            <button className="act" disabled={busy || holder.trim() === "" || iban.trim() === ""}>
              {tr("payer.save")}
            </button>
          </div>
        </form>
      )}
    </SheetCard>
  );
}

function NewPaymentCard({
  view,
  act,
  busy,
  tr,
}: {
  view: PaymentsView;
  act: Act;
  busy: boolean;
  tr: Tr;
}) {
  const blank = {
    kind: view.things.suppliers.length > 0 ? "supplier" : "other",
    supplier_id: view.things.suppliers[0]?.id ?? "",
    cost_item_id: view.things.fixed_costs[0]?.id ?? "",
    ref: "",
    payee_name: "",
    iban: "",
    bic: "",
    amount: "",
    currency: "EUR",
    reference: "",
    execution_date: view.today,
  };
  const [f, setF] = useState(blank);
  const minor = amountToMinor(f.amount, f.currency);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const pickCost = (id: string) => {
    const c = view.things.fixed_costs.find((x) => x.id === id);
    setF({
      ...f,
      cost_item_id: id,
      ...(c?.amount && f.amount === ""
        ? {
            currency: c.amount.currency,
            amount: moneyText(c.amount, "en").replace(/[^0-9.]/g, ""),
          }
        : {}),
      ...(c?.label && f.reference === "" ? { reference: c.label } : {}),
    });
  };
  return (
    <SheetCard label={tr("form.label")} title={tr("form.title")} foot={tr("form.foot")}>
      <form
        className="py-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (minor === null) return;
          act(
            {
              action: "propose",
              payment: {
                payee_name: f.payee_name,
                iban: f.iban,
                bic: f.bic,
                amount: { amount_minor: minor, currency: f.currency.trim().toUpperCase() },
                reference: f.reference,
                execution_date: f.execution_date,
                pays: {
                  kind: f.kind,
                  supplier_id: f.kind === "supplier" ? f.supplier_id : null,
                  cost_item_id: f.kind === "fixed_cost" ? f.cost_item_id : null,
                  ref: f.kind === "purchase_order" ? f.ref : null,
                },
              },
            },
            tr("form.done"),
          );
          setF(blank);
        }}
      >
        <label className="py-field">
          <span className="label">{tr("form.pays")}</span>
          <select value={f.kind} onChange={set("kind")}>
            {view.things.suppliers.length > 0 && (
              <option value="supplier">{tr("pays.supplier")}</option>
            )}
            {view.things.fixed_costs.length > 0 && (
              <option value="fixed_cost">{tr("pays.fixed_cost")}</option>
            )}
            <option value="purchase_order">{tr("pays.purchase_order")}</option>
            <option value="other">{tr("pays.other")}</option>
          </select>
        </label>
        {f.kind === "supplier" && (
          <label className="py-field">
            <span className="label">{tr("form.supplier")}</span>
            <select value={f.supplier_id} onChange={set("supplier_id")}>
              {view.things.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? tr("form.unnamedSupplier")}
                </option>
              ))}
            </select>
          </label>
        )}
        {f.kind === "fixed_cost" && (
          <label className="py-field">
            <span className="label">{tr("form.cost")}</span>
            <select value={f.cost_item_id} onChange={(e) => pickCost(e.target.value)}>
              {view.things.fixed_costs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? tr("form.unnamedCost")}
                </option>
              ))}
            </select>
          </label>
        )}
        {f.kind === "purchase_order" && (
          <label className="py-field">
            <span className="label">{tr("form.order")}</span>
            <input value={f.ref} onChange={set("ref")} />
          </label>
        )}
        <label className="py-field">
          <span className="label">
            {f.kind === "supplier" ? tr("form.payeeOptional") : tr("form.payee")}
          </span>
          <input value={f.payee_name} onChange={set("payee_name")} autoComplete="off" />
        </label>
        <label className="py-field">
          <span className="label">{tr("form.iban")}</span>
          <input value={f.iban} onChange={set("iban")} autoComplete="off" spellCheck={false} />
        </label>
        <label className="py-field">
          <span className="label">{tr("form.bic")}</span>
          <input value={f.bic} onChange={set("bic")} autoComplete="off" spellCheck={false} />
        </label>
        <label className="py-field">
          <span className="label">{tr("form.amount")}</span>
          <input value={f.amount} onChange={set("amount")} inputMode="decimal" />
        </label>
        <label className="py-field">
          <span className="label">{tr("form.currency")}</span>
          <input value={f.currency} onChange={set("currency")} maxLength={3} />
        </label>
        <label className="py-field">
          <span className="label">{tr("form.date")}</span>
          <input
            type="date"
            value={f.execution_date}
            min={view.today}
            onChange={set("execution_date")}
          />
        </label>
        <label className="py-field py-wide">
          <span className="label">{tr("form.reference")}</span>
          <input value={f.reference} onChange={set("reference")} maxLength={140} />
        </label>
        <div className="py-wide">
          {f.amount.trim() !== "" && minor === null && (
            <p className="py-fine">{tr("form.badAmount")}</p>
          )}
          <button
            className="act solid"
            disabled={busy || minor === null || f.iban.trim() === "" || f.reference.trim() === ""}
          >
            {tr("form.submit")}
          </button>
        </div>
      </form>
    </SheetCard>
  );
}

export function PaymentsScreen() {
  const { tr } = useTr("payments");
  const [view, setView] = useState<PaymentsView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/payments");
      if (res.status === 401) return setFailed("signed_out");
      // Owner only (least privilege): a manager or a viewer reads the role refusal, nothing else.
      if (res.status === 403) {
        const j = (await res.json().catch(() => ({}))) as { error?: unknown };
        return setRefused(typeof j.error === "string" ? j.error : "");
      }
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as PaymentsView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act: Act = (body, done) => {
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const res = await fetch("/api/payments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as Record<string, unknown>;
        if (!res.ok) setNote(refusalWords(j, tr));
        else {
          setNote(done);
          await load();
        }
      } catch {
        setNote(tr("error.ourSide"));
      } finally {
        setBusy(false);
      }
    })();
  };

  // A NEW file: the server records it as a batch and puts in it only the
  // payments in no file yet, then the browser saves it under its own name.
  const download: Download = (format, count) => {
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const res = await fetch("/api/payments/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format }),
        });
        if (!res.ok) {
          setNote(refusalWords((await res.json()) as Record<string, unknown>, tr));
          await load();
          return;
        }
        const name =
          /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
          `syb-${format}.txt`;
        const href = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
        setNote(tr("download.done", { count }));
        await load();
      } catch {
        setNote(tr("error.ourSide"));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (refused !== null) {
    return (
      <Frame title={tr("refused")}>
        <p className="py-fine">{refused || tr("ownerOnly")}</p>
      </Frame>
    );
  }
  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut")}>
        <p className="py-fine">
          <Link href="/intake">{tr("start")}</Link>
        </p>
      </Frame>
    );
  }
  if (failed === "error") return <Frame title={tr("error.load")} />;
  if (view === null) {
    return (
      <Frame title={tr("loading")}>
        <p className="py-fine live">{tr("loading")}</p>
      </Frame>
    );
  }
  const groups = groupPayments(view.payments);
  return (
    <Frame
      title={
        groups.ready.length > 0
          ? tr("title.ready", { count: groups.ready.length })
          : tr("title.none")
      }
    >
      {note && (
        <p className="py-note" role="status">
          {note}
        </p>
      )}
      <ReadyCard view={view} rows={groups.ready} act={act} download={download} busy={busy} />
      <FilesCard files={view.exports} />
      <WaitingCard rows={groups.waiting} />
      {view.can_prepare && <NewPaymentCard view={view} act={act} busy={busy} tr={tr} />}
      <PayerCard view={view} act={act} busy={busy} />
      <ClosedCard rows={groups.closed} act={act} busy={busy} canPrepare={view.can_prepare} />
      {!view.can_prepare && <p className="py-fine">{tr("ownerOnly")}</p>}
    </Frame>
  );
}
