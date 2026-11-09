// Tests only (P6-09): read a purchase-order PDF back as text — a small
// parser over what pdf-lib writes, so the tests check the document a
// supplier opens, not the code that drew it. It loads the file with
// pdf-lib (a broken file fails here), inflates each page's content stream,
// follows `/Font size Tf` and `<hex> Tj`, and maps each glyph id back to
// characters through that font's own ToUnicode CMap.

import type { PDFRef } from "pdf-lib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

function streamText(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

const utf16 = (hex: string): string => {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
};

/** glyph id (hex, 4 digits) → characters, from a ToUnicode CMap. */
function cmapOf(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(m[1]!.toUpperCase(), utf16(m[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const base = parseInt(m[3]!, 16);
      for (let g = lo; g <= hi; g++) {
        map.set(g.toString(16).toUpperCase().padStart(4, "0"), String.fromCharCode(base + g - lo));
      }
    }
  }
  return map;
}

export interface PdfText {
  pages: number;
  /** Every drawn run of text, in drawing order, page by page. */
  runs: string[];
  /** The same runs with where they were drawn: the page (from 1) and the baseline's y. */
  placed: { text: string; page: number; y: number }[];
  /** The document's info dictionary, as pdf-lib reads it back. */
  title: string | undefined;
  producer: string | undefined;
  creationDate: Date | undefined;
}

export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const runs: string[] = [];
  const placed: PdfText["placed"] = [];
  for (const [index, page] of doc.getPages().entries()) {
    const fonts = new Map<string, Map<string, string>>();
    const fontDict = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = doc.context.lookup(ref as PDFRef, PDFDict);
      const toUnicode = font.lookup(PDFName.of("ToUnicode"));
      fonts.set(
        name.asString().slice(1),
        toUnicode instanceof PDFRawStream ? cmapOf(streamText(toUnicode)) : new Map(),
      );
    }
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r))
        : [contents];
    let current = new Map<string, string>();
    let y = Number.NaN;
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const ops = streamText(s);
      for (const m of ops.matchAll(
        /\/(\S+)\s+[\d.]+\s+Tf|(-?[\d.]+)\s+Tm|<([0-9a-fA-F]*)>\s*Tj/g,
      )) {
        if (m[1] !== undefined) {
          current = fonts.get(m[1]) ?? new Map();
          continue;
        }
        if (m[2] !== undefined) {
          y = Number(m[2]);
          continue;
        }
        const hex = m[3]!.toUpperCase();
        let run = "";
        for (let i = 0; i < hex.length; i += 4) run += current.get(hex.slice(i, i + 4)) ?? "�";
        runs.push(run);
        placed.push({ text: run, page: index + 1, y });
      }
    }
  }
  return {
    pages: doc.getPageCount(),
    runs,
    placed,
    title: doc.getTitle(),
    producer: doc.getProducer(),
    creationDate: doc.getCreationDate(),
  };
}
