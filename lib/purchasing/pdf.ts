// A purchase order as a PDF — P6-09 (Phase 6), beside P6-04's HTML page.
//
// The same order, the same words and the same content as poDocument (po.ts):
// the business and the supplier, the order's number and day, the delivery
// address, every line (item, quantity, unit price, line total), the total
// (exact minor units, formatted per currency, never added across two; the
// lines without a price stated), the note, the order's status and the foot.
// A4, one font (DejaVu Sans, cut down: lib/purchasing/fonts/dejavu-sans.ts),
// pages added as the lines need them, the table head repeated on each.
//
// Pure-JS (pdf-lib + @pdf-lib/fontkit, both MIT): no native module, no
// binary, nothing fetched — it runs wherever the order is read or sent.
//
// Deterministic: the same order, words and status give the same bytes. The
// document's dates are the day the order was prepared, its producer is SYB,
// the font's name is fixed (pdf-lib otherwise adds a random suffix), and
// nothing reads the clock.
//
// Languages. The font covers Latin (Hungarian ő ű included), Greek and
// Cyrillic; it has no Chinese. A CJK face would be megabytes in every
// function that sends an order, so a zh-Hans business's PDF is written in
// English (pdfLocale) — said here, in the font module and in P6-09's
// status — and its HTML document stays in its own language. Any character
// the font lacks (a supplier's name in Chinese, an emoji in a note) prints
// as "?", never as an invisible box.
//
// Money never passes through a float here: amounts arrive as integer minor
// units and are worded by exactMoney (lib/stock/words), the same as the
// email and the HTML page.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import type { Money } from "../core/money";
import type { AppLocale } from "../i18n/locales";
import type { Words as RecipientWords } from "../i18n/recipient";
import { exactMoney, isoDay } from "../stock/words";
import { DEJAVU_SANS_BOLD_BASE64, DEJAVU_SANS_REGULAR_BASE64 } from "./fonts/dejavu-sans";
import type { PoDocStatus, PoLine, PurchaseOrder } from "./po";
import { pricedLine, statusWords, totalWords } from "./po";

/** The languages the embedded font can write; any other is written in English. */
export const PDF_LOCALES: readonly AppLocale[] = [
  "en",
  "es-ES",
  "de-DE",
  "fr-FR",
  "hu-HU",
  "ru-RU",
];

/** Pure: the language the PDF is written in — the business's when the font covers its script, else English. */
export function pdfLocale(locale: AppLocale): AppLocale {
  return PDF_LOCALES.includes(locale) ? locale : "en";
}

/** Pure: the file's name, "PO-0007.pdf". */
export function poPdfFilename(po: Pick<PurchaseOrder, "number">): string {
  const safe = po.number.replace(/[^A-Za-z0-9-]/g, "") || "purchase-order";
  return `${safe}.pdf`;
}

/* ── the page ── */

const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 50;
const CONTENT = A4.width - 2 * MARGIN;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.36, 0.36, 0.36);
const RULE = rgb(0.84, 0.84, 0.84);

/** Columns of the lines table: item, quantity, unit price, line total. */
const COLS = [
  { width: 185, align: "left" },
  { width: 80, align: "right" },
  { width: 115, align: "right" },
  { width: CONTENT - 185 - 80 - 115, align: "right" },
] as const;
const CELL_PAD = 5;

/* fontkit's own type file doesn't match pdf-lib's Fontkit interface exactly. */
type Fontkit = Parameters<PDFDocument["registerFontkit"]>[0];

let fontBytes: { regular: Uint8Array; bold: Uint8Array } | null = null;
function fonts(): { regular: Uint8Array; bold: Uint8Array } {
  fontBytes ??= {
    regular: Uint8Array.from(Buffer.from(DEJAVU_SANS_REGULAR_BASE64, "base64")),
    bold: Uint8Array.from(Buffer.from(DEJAVU_SANS_BOLD_BASE64, "base64")),
  };
  return fontBytes;
}

/** Pure: text the font can draw — line breaks kept, tabs as spaces, control characters dropped, what it lacks as "?". */
export function drawable(text: string, has: ReadonlySet<number>): string {
  let out = "";
  for (const ch of text.replace(/\t/g, " ")) {
    const cp = ch.codePointAt(0)!;
    out += ch === "\n" || has.has(cp) ? ch : cp < 0x20 ? "" : "?";
  }
  return out;
}

/** Pure: words broken into lines no wider than `width`; a word too long for one line is cut. */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      if (word === "") continue;
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line !== "") out.push(line);
      // A single word wider than the column: cut it, character by character.
      let rest = word;
      while (measure(rest) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > width) cut--;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    out.push(line);
  }
  // A paragraph that was only spaces leaves an empty line; trailing ones are dropped.
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

interface Pen {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  has: ReadonlySet<number>;
}

const fmt = (m: Money, locale: AppLocale) => exactMoney(m.amount_minor, m.currency, locale);

/**
 * Pure (async only because pdf-lib is): the order as an A4 PDF, in the words
 * it is handed — the "emails.purchaseOrder" namespace, in pdfLocale's
 * language — with its status line. Same order, words and status, same bytes.
 */
export async function renderPurchaseOrderPdf(
  po: PurchaseOrder,
  w: RecipientWords,
  status: PoDocStatus = { kind: "approved" },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit as unknown as Fontkit);
  const bytes = fonts();
  const regular = await doc.embedFont(bytes.regular, {
    subset: true,
    customName: "SYB-DejaVuSans",
  });
  const bold = await doc.embedFont(bytes.bold, { subset: true, customName: "SYB-DejaVuSans-Bold" });
  const has = new Set(regular.getCharacterSet());

  // The document's own facts: fixed, from the order — never the clock.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(po.prepared_on) ? po.prepared_on : "2000-01-01";
  const when = new Date(`${day}T00:00:00Z`);
  const title = w.t("doc.title", { number: po.number });
  doc.setTitle(drawable(title, has), { showInWindowTitleBar: true });
  doc.setAuthor(drawable(po.business, has));
  doc.setSubject(drawable(title, has));
  doc.setCreator("SYB");
  doc.setProducer("SYB");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setLanguage(w.locale === "zh-Hans" ? "zh-Hans" : (w.locale.split("-")[0] ?? "en"));

  const pen: Pen = {
    doc,
    page: doc.addPage([A4.width, A4.height]),
    y: A4.height - MARGIN,
    regular,
    bold,
    has,
  };

  const text = (
    s: string,
    x: number,
    size: number,
    opts: {
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      width?: number;
      align?: "left" | "right";
    } = {},
  ): number => {
    const font = opts.font ?? regular;
    const width = opts.width ?? CONTENT - (x - MARGIN);
    const lines = wrapText(drawable(s, has), width, (t) => font.widthOfTextAtSize(t, size));
    const lead = size * 1.35;
    for (const [i, line] of lines.entries()) {
      const dx = opts.align === "right" ? width - font.widthOfTextAtSize(line, size) : 0;
      pen.page.drawText(line, {
        x: x + dx,
        y: pen.y - size - i * lead,
        size,
        font,
        color: opts.color ?? INK,
      });
    }
    return lines.length * lead;
  };

  /** Room for `height` more points on this page, or a fresh page. */
  const room = (height: number): boolean => {
    if (pen.y - height >= MARGIN + 24) return false;
    pen.page = doc.addPage([A4.width, A4.height]);
    pen.y = A4.height - MARGIN;
    return true;
  };

  // Title, prepared line, status.
  pen.y -= text(title, MARGIN, 20, { font: bold });
  pen.y -= 2;
  pen.y -= text(
    w.t("doc.prepared", { business: po.business, day: isoDay(po.prepared_on, w.locale) }),
    MARGIN,
    10,
    { color: MUTED },
  );
  pen.y -= 10;
  const statusLine = drawable(statusWords(status, w), has);
  const statusWidth = Math.min(CONTENT, regular.widthOfTextAtSize(statusLine, 9) + 16);
  const statusH = text(statusLine, MARGIN + 8, 9, { width: statusWidth - 16 }) + 8;
  pen.page.drawRectangle({
    x: MARGIN,
    y: pen.y - statusH,
    width: statusWidth,
    height: statusH + 4,
    borderColor: MUTED,
    borderWidth: 0.75,
  });
  pen.y -= statusH + 22;

  // From, to, deliver to: three columns.
  const colW = (CONTENT - 2 * 18) / 3;
  const blocks: [string, string][] = [
    [w.t("doc.from"), po.business],
    [w.t("doc.to"), `${po.supplier.name}\n${po.supplier.email}`],
    [w.t("deliverTo"), po.delivery_address],
  ];
  const top = pen.y;
  let lowest = top;
  for (const [i, [label, value]] of blocks.entries()) {
    pen.y = top;
    const x = MARGIN + i * (colW + 18);
    pen.y -= text(label.toLocaleUpperCase(w.locale), x, 8, { color: MUTED, width: colW });
    pen.y -= 3;
    pen.y -= text(value, x, 10, { width: colW });
    lowest = Math.min(lowest, pen.y);
  }
  pen.y = lowest - 20;

  // The lines.
  const heads = [w.t("doc.item"), w.t("doc.quantity"), w.t("doc.unit"), w.t("doc.lineTotal")];
  const xs = COLS.map((_, i) => MARGIN + COLS.slice(0, i).reduce((a, c) => a + c.width, 0));
  const cell = (s: string, i: number, size: number, font: PDFFont, color = INK) =>
    text(s, xs[i]! + CELL_PAD, size, {
      font,
      color,
      width: COLS[i]!.width - 2 * CELL_PAD,
      align: COLS[i]!.align,
    });
  const ruleBelow = () => {
    pen.page.drawLine({
      start: { x: MARGIN, y: pen.y },
      end: { x: MARGIN + CONTENT, y: pen.y },
      thickness: 0.6,
      color: RULE,
    });
  };
  const head = () => {
    const h = Math.max(...heads.map((s, i) => cell(s, i, 8.5, bold, MUTED)));
    pen.y -= h + 5;
    ruleBelow();
    pen.y -= 6;
  };
  // Decision 4 (2026-11-09): a price only where one was stated or measured.
  const unitText = (l: PoLine): string => {
    const p = pricedLine(l);
    return p ? fmt(p.unit, w.locale) : w.t("doc.toConfirm");
  };
  const rowHeight = (l: PoLine): number => {
    const size = 10;
    const height = (s: string, col: number) =>
      wrapText(drawable(s, has), COLS[col]!.width - 2 * CELL_PAD, (t) =>
        regular.widthOfTextAtSize(t, size),
      ).length;
    return Math.max(height(l.name, 0), height(unitText(l), 2)) * size * 1.35 + 11;
  };
  head();
  for (const l of po.lines) {
    if (room(rowHeight(l))) head();
    const p = pricedLine(l);
    const h = Math.max(
      cell(l.name, 0, 10, regular),
      cell(String(l.quantity), 1, 10, regular),
      cell(unitText(l), 2, 10, regular),
      cell(p ? fmt(p.total, w.locale) : "—", 3, 10, regular),
    );
    pen.y -= h + 5;
    ruleBelow();
    pen.y -= 6;
  }

  /**
   * Text that may be longer than the room left (the total, a note of up to
   * PO.max_note characters): drawn a line at a time, onto a fresh page when
   * this one is full, so no line is drawn below the margin or off the page.
   */
  const flow = (s: string, size: number, font: PDFFont = regular) => {
    const lead = size * 1.35;
    for (const line of wrapText(drawable(s, has), CONTENT, (t) =>
      font.widthOfTextAtSize(t, size),
    )) {
      room(lead);
      pen.page.drawText(line, { x: MARGIN, y: pen.y - size, size, font, color: INK });
      pen.y -= lead;
    }
  };

  // The total, the note, the foot.
  const total = totalWords(po, w);
  if (total) {
    room(30);
    pen.y -= 6;
    flow(total, 11, bold);
  }
  if (po.note) {
    room(50);
    pen.y -= 14;
    pen.y -= text(w.t("noteHead").toLocaleUpperCase(w.locale), MARGIN, 8, { color: MUTED });
    pen.y -= 3;
    flow(po.note, 10);
  }
  room(40);
  pen.y -= 24;
  text(w.t("doc.foot"), MARGIN, 8, { color: MUTED });

  // Each page's own number, in figures only: "PO-0007 · 1/2".
  const pages = doc.getPages();
  for (const [i, page] of pages.entries()) {
    const mark = drawable(`${po.number} · ${i + 1}/${pages.length}`, has);
    page.drawText(mark, {
      x: A4.width - MARGIN - regular.widthOfTextAtSize(mark, 8),
      y: MARGIN - 20,
      size: 8,
      font: regular,
      color: MUTED,
    });
  }

  return doc.save({ useObjectStreams: false });
}
