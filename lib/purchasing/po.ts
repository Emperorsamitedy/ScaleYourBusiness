// Purchase orders, the pure half — Phase 6 (P6-04, rule 27 amended).
//
// A reorder suggestion (lib/stock/cover's reorderFor, P5-03) can become a
// purchase order: one supplier, its lines (the items it supplies that are
// running low), each line's quantity with the arithmetic behind it (rule 6),
// a unit cost as Money where the stock read carries one (rule 1), the
// delivery address and the supplier's email address. Everything here is
// arithmetic and wording: no database, no network, no model.
//
// What this file decides:
//   · the lines and their totals, per currency — never added across two;
//   · the order's fingerprint (poSha256), over a canonical form, so the
//     sender can prove the email it sends is the order the owner approved;
//   · whether email can really go out (sendingMode), from the environment
//     it is handed: SYB's email service with a sender on a verified domain,
//     AND the real-write gate on (SESSION_D_REAL_WRITES). Otherwise the
//     engine runs the order against the fake sender and the screen says why;
//   · the email and the document, in the words it is handed.
//
// SYB never edits, cancels or pays an order and never signs in to a
// supplier's system: there is nothing here, or anywhere, that could.

import { createHash } from "node:crypto";
import type { Money } from "../core/money";
import type { AppLocale } from "../i18n/locales";
import type { Words as RecipientWords } from "../i18n/recipient";
import { exactMoney, isoDay } from "../stock/words";

/** The proposal kind a purchase order carries (lib/proposals/hard-limits ORDER_KINDS). */
export const PO_KIND = "purchase_order";
/** The provider and its one operation (lib/execution/scopes). */
export const PO_PROVIDER = "purchase_order";
export const PO_OP = "send_purchase_order";

export const PO = {
  /** An order is about this week's stock: it lapses, undecided, after this many days. */
  expiry_days: 14,
  /** Most lines one order carries. */
  max_lines: 25,
  /** Longest delivery address and note, in characters. */
  max_address: 400,
  max_note: 600,
  /** A quantity an owner may type, at most (a typo guard, not a business rule). */
  max_quantity: 1_000_000,
} as const;

export interface PoLine {
  /** connection_id:ref — which stock item. */
  key: string;
  name: string;
  quantity: number;
  /** What the reorder suggestion said (rule 6): the owner may change it, and the order says so. */
  suggested: number;
  unit_cost: Money | null;
  cost_basis: "measured" | "stated" | null;
  line_total: Money | null;
  /** The suggestion's arithmetic, in English as stored (rules 4 and 7). */
  arithmetic: string;
}

export interface PurchaseOrder {
  /** "PO-0007": this business's own sequence. */
  number: string;
  /** The business's own name, as the supplier knows it. */
  business: string;
  supplier: {
    id: string;
    name: string;
    email: string;
    /** The fact the address is recorded as (rule 2): suppliers.<id>.email. */
    email_field: string;
  };
  lines: PoLine[];
  /** One total per currency; lines without a unit cost are counted in `unpriced`. */
  totals: Money[];
  unpriced: number;
  delivery_address: string;
  /** Where the address came from: a fact key, or null when typed on this order. */
  delivery_address_field: string | null;
  note: string | null;
  /** YYYY-MM-DD, the day it was prepared (shown as words, never as this). */
  prepared_on: string;
}

/* ── small checks ── */

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Pure: a plausible single email address, normalised (trimmed, lower case), or null. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) return null;
  return v;
}

/** Pure: a delivery address or note as text, trimmed, with no control characters but line breaks. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const v = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (v === "") return null;
  return v.slice(0, max);
}

/** Pure: "PO-0007". */
export function poNumber(n: number): string {
  return `PO-${String(Math.max(1, Math.floor(n))).padStart(4, "0")}`;
}

/** Pure: a quantity the owner typed — a whole number from 1 up, or null. */
export function readQuantity(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > PO.max_quantity) return null;
  return n;
}

/* ── the lines ── */

export interface SuggestedLine {
  key: string;
  name: string;
  suggested: number;
  /** The suggestion's own arithmetic (cover.reorder.arithmetic, English). */
  arithmetic: string;
  /** From the stock read: value at cost ÷ on hand, as reorderFor works it out. */
  unit_cost: Money | null;
  cost_basis: "measured" | "stated" | null;
}

/** Pure: one line, at the owner's quantity when they gave one, with its arithmetic. */
export function poLine(s: SuggestedLine, chosen: number | null): PoLine {
  const quantity = chosen ?? s.suggested;
  const arithmetic =
    quantity === s.suggested
      ? s.arithmetic
      : `You chose ${quantity}; the suggestion was ${s.suggested}: ${s.arithmetic}`;
  return {
    key: s.key,
    name: s.name,
    quantity,
    suggested: s.suggested,
    unit_cost: s.unit_cost,
    cost_basis: s.cost_basis,
    line_total:
      s.unit_cost === null
        ? null
        : { amount_minor: s.unit_cost.amount_minor * quantity, currency: s.unit_cost.currency },
    arithmetic,
  };
}

/** Pure: the order's totals, one per currency, in the order the currencies first appear. */
export function poTotals(lines: readonly PoLine[]): { totals: Money[]; unpriced: number } {
  const by = new Map<string, number>();
  let unpriced = 0;
  for (const l of lines) {
    if (l.line_total === null) {
      unpriced++;
      continue;
    }
    by.set(l.line_total.currency, (by.get(l.line_total.currency) ?? 0) + l.line_total.amount_minor);
  }
  return {
    totals: [...by.entries()].map(([currency, amount_minor]) => ({ amount_minor, currency })),
    unpriced,
  };
}

/* ── the fingerprint ── */

/** Pure: JSON with every object's keys sorted, so a jsonb round trip hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Pure: the order as approved, fingerprinted. */
export function poSha256(po: PurchaseOrder): string {
  return createHash("sha256").update(canonicalJson(po)).digest("hex");
}

/* ── can it really go out ── */

export type NotSentReason = "email_not_set_up" | "real_writes_off";

export type SendingMode =
  | { mode: "real"; api_key: string; from_address: string }
  | { mode: "fake"; reasons: NotSentReason[] };

const RESEND_SANDBOX = "onboarding@resend.dev";

/** Pure: the bare address of a From value ("SYB <hello@x.com>" → "hello@x.com"), or null. */
export function fromAddress(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const address = (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return normaliseEmail(address);
}

/**
 * Pure: whether a purchase order can really be emailed, from the environment
 * it is handed. Real only when SYB's email service has a key, its sender is
 * an address on a domain (not Resend's sandbox, which reaches only the Resend
 * account's own owner), and the real-write gate is on. Every reason it can't
 * is named, so the screen can say all of them.
 */
export function sendingMode(env: Readonly<Record<string, string | undefined>>): SendingMode {
  const key = env.RESEND_API_KEY?.trim() ?? "";
  const from = fromAddress(env.EMAIL_FROM);
  const reasons: NotSentReason[] = [];
  if (key === "" || from === null || from === RESEND_SANDBOX) reasons.push("email_not_set_up");
  if (env.SESSION_D_REAL_WRITES?.trim() !== "on") reasons.push("real_writes_off");
  return reasons.length === 0 && from !== null
    ? { mode: "real", api_key: key, from_address: from }
    : { mode: "fake", reasons };
}

/** Pure: '"Fernhill Ceramics via SYB" <address>' — the business's name, SYB's verified address. */
export function poFromHeader(business: string, address: string): string {
  const name = business.replace(/["<>\r\n\\]/g, "").trim() || "A business";
  return `"${name} via SYB" <${address}>`;
}

/* ── the words ── */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmt = (m: Money, locale: AppLocale) => exactMoney(m.amount_minor, m.currency, locale);

/** Pure: one line in words: "50 × Speckled Everyday Mug at €9.80 = €490.00". */
export function lineWords(l: PoLine, w: RecipientWords): string {
  return l.unit_cost && l.line_total
    ? w.t("linePriced", {
        quantity: l.quantity,
        item: l.name,
        unit: fmt(l.unit_cost, w.locale),
        total: fmt(l.line_total, w.locale),
      })
    : w.t("line", { quantity: l.quantity, item: l.name });
}

/** Pure: the totals in words, or null when no line has a price. */
export function totalWords(po: PurchaseOrder, w: RecipientWords): string | null {
  if (po.totals.length === 0) return null;
  const amounts = po.totals.map((t) => fmt(t, w.locale)).join(" + ");
  return po.unpriced > 0
    ? w.t("totalPart", { total: amounts, unpriced: po.unpriced })
    : w.t("total", { total: amounts });
}

export interface PoEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Pure: the email to the supplier, in the words it is handed (the
 * "emails.purchaseOrder" namespace, in the business's language). Plain text
 * and a matching HTML part; every value from data is escaped in the HTML.
 */
export function poEmail(po: PurchaseOrder, w: RecipientWords): PoEmail {
  const subject = w.t("subject", { number: po.number, business: po.business });
  const lines = po.lines.map((l) => lineWords(l, w));
  const total = totalWords(po, w);
  const parts = [
    w.t("greeting", { supplier: po.supplier.name }),
    w.t("intro", { business: po.business, number: po.number }),
    lines.map((l) => `- ${l}`).join("\n"),
    ...(total ? [total] : []),
    `${w.t("deliverTo")}\n${po.delivery_address}`,
    ...(po.note ? [`${w.t("noteHead")}\n${po.note}`] : []),
    w.t("confirm"),
    w.t("closing", { business: po.business }),
    w.t("footer"),
  ];
  const text = parts.join("\n\n");
  const html = [
    `<p>${esc(w.t("greeting", { supplier: po.supplier.name }))}</p>`,
    `<p>${esc(w.t("intro", { business: po.business, number: po.number }))}</p>`,
    `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`,
    ...(total ? [`<p><strong>${esc(total)}</strong></p>`] : []),
    `<p><strong>${esc(w.t("deliverTo"))}</strong><br>${esc(po.delivery_address).replace(/\n/g, "<br>")}</p>`,
    ...(po.note
      ? [
          `<p><strong>${esc(w.t("noteHead"))}</strong><br>${esc(po.note).replace(/\n/g, "<br>")}</p>`,
        ]
      : []),
    `<p>${esc(w.t("confirm"))}</p>`,
    `<p>${esc(w.t("closing", { business: po.business }))}</p>`,
    `<p style="color:#666;font-size:12px">${esc(w.t("footer"))}</p>`,
  ].join("\n");
  return { subject, text, html };
}

/** Where the order stands, for the document's own line. */
export type PoDocStatus =
  { kind: "draft" } | { kind: "approved" } | { kind: "sent"; on: string } | { kind: "not_sent" };

/**
 * Pure: the order as a printable page — what the owner downloads, keeps,
 * prints or saves as a PDF from the browser. The same lines and words as
 * the email, laid out as a document. Self-contained: no script, no external
 * file, every value escaped.
 */
export function poDocument(po: PurchaseOrder, w: RecipientWords, status: PoDocStatus): string {
  const lang = w.locale === "zh-Hans" ? "zh-Hans" : w.locale.split("-")[0];
  const row = (l: PoLine) =>
    `<tr><td>${esc(l.name)}</td><td class="n">${esc(String(l.quantity))}</td><td class="n">${
      l.unit_cost ? esc(fmt(l.unit_cost, w.locale)) : "—"
    }</td><td class="n">${l.line_total ? esc(fmt(l.line_total, w.locale)) : "—"}</td></tr>`;
  const total = totalWords(po, w);
  const statusLine =
    status.kind === "sent"
      ? w.t("doc.statusSent", { day: isoDay(status.on, w.locale) })
      : w.t(`doc.status.${status.kind}`);
  return `<!doctype html>
<html lang="${esc(lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.t("doc.title", { number: po.number }))}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:32px 16px}
main{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.meta{color:#555;margin:0 0 24px}
.cols{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:24px}
.cols div{flex:1 1 220px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:0 0 4px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #ddd;vertical-align:top}
th{font-size:12px;color:#555}
.n{text-align:right;white-space:nowrap}
.total{font-weight:600}
.status{display:inline-block;border:1px solid #999;padding:2px 8px;font-size:12px;margin-bottom:16px}
.foot{color:#666;font-size:12px;margin-top:32px}
pre{font:inherit;white-space:pre-wrap;margin:0}
@media print{body{padding:0}.status{border-color:#000}}
</style>
</head>
<body>
<main>
<h1>${esc(w.t("doc.title", { number: po.number }))}</h1>
<p class="meta">${esc(w.t("doc.prepared", { business: po.business, day: isoDay(po.prepared_on, w.locale) }))}</p>
<p class="status">${esc(statusLine)}</p>
<div class="cols">
<div><p class="label">${esc(w.t("doc.from"))}</p><p>${esc(po.business)}</p></div>
<div><p class="label">${esc(w.t("doc.to"))}</p><p>${esc(po.supplier.name)}<br>${esc(po.supplier.email)}</p></div>
<div><p class="label">${esc(w.t("deliverTo"))}</p><pre>${esc(po.delivery_address)}</pre></div>
</div>
<table>
<thead><tr><th>${esc(w.t("doc.item"))}</th><th class="n">${esc(w.t("doc.quantity"))}</th><th class="n">${esc(w.t("doc.unit"))}</th><th class="n">${esc(w.t("doc.lineTotal"))}</th></tr></thead>
<tbody>
${po.lines.map(row).join("\n")}
</tbody>
</table>
${total ? `<p class="total">${esc(total)}</p>` : ""}
${po.note ? `<p class="label">${esc(w.t("noteHead"))}</p><pre>${esc(po.note)}</pre>` : ""}
<p class="foot">${esc(w.t("doc.foot"))}</p>
</main>
</body>
</html>
`;
}
