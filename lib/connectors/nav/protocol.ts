// NAV Online Számla v3 — the read-only protocol, pure (the multi-market
// spec Part E; facts in specs/nav-online-szamla-v3.md).
//
// Three operations exist here and no others: queryTaxpayer,
// queryInvoiceDigest, queryInvoiceData. NAV_OPERATIONS is the closed set,
// and a source scan (nav.test.ts) fails if any write or submit operation's
// name appears anywhere in the codebase. The exchange key — used only to
// decrypt tokens for invoice submission — is never asked for or held.
//
// Signing follows the PHP client pzs/nav-online-invoice:
//   passwordHash     = UPPER(hex(SHA-512(password)))
//   requestSignature = UPPER(hex(SHA3-512(requestId + yyyyMMddHHmmss + signatureKey)))
// with the timestamp in UTC, the header's own instant without milliseconds.
//
// Amounts arrive as decimals with at most two places; they are read into
// integer minor units from their digits (rule 1), never through a float.

import { createHash } from "node:crypto";
import { currencyRow } from "../../core/currency-table";
import { isIsoCurrency } from "../../core/currencies";

export const NAV_OPERATIONS = ["queryTaxpayer", "queryInvoiceDigest", "queryInvoiceData"] as const;
export type NavOperation = (typeof NAV_OPERATIONS)[number];

export const NAV_ENDPOINTS = {
  test: "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3",
  prod: "https://api.onlineszamla.nav.gov.hu/invoiceService/v3",
} as const;

const API_NS = "http://schemas.nav.gov.hu/OSA/3.0/api";
const COMMON_NS = "http://schemas.nav.gov.hu/NTCA/1.0/common";

export class NavProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavProtocolError";
  }
}

/** The technical user's credentials. Never logged; see ./redact.ts. */
export interface NavCredentials {
  login: string;
  password: string;
  signatureKey: string;
  /** The taxpayer's 8-digit tax number (törzsszám). */
  taxNumber: string;
}

/** SYB's own identity as calling software — config, set once, never per install. */
export interface NavSoftware {
  softwareId: string;
  softwareName: string;
  softwareOperation: "ONLINE_SERVICE" | "LOCAL_SOFTWARE";
  softwareMainVersion: string;
  softwareDevName: string;
  softwareDevContact: string;
  softwareDevCountryCode?: string;
  softwareDevTaxNumber?: string;
}

export function validateSoftware(s: NavSoftware): NavSoftware {
  if (!/^[0-9A-Z-]{18}$/.test(s.softwareId)) {
    throw new NavProtocolError("the software ID is 18 characters: digits, capitals and hyphens");
  }
  for (const k of [
    "softwareName",
    "softwareMainVersion",
    "softwareDevName",
    "softwareDevContact",
  ] as const) {
    if (s[k].trim() === "") throw new NavProtocolError(`${k} is required by NAV`);
  }
  return s;
}

const upperHex = (algo: string, input: string) =>
  createHash(algo).update(input, "utf8").digest("hex").toUpperCase();

export function passwordHash(password: string): string {
  return upperHex("sha512", password);
}

/** "2026-11-10T12:34:56.789Z" → "20261110123456". */
export function signatureTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/\.\d{3}/, "").replace(/\D+/g, "");
}

export function requestSignature(
  requestId: string,
  isoTimestamp: string,
  signatureKey: string,
): string {
  return upperHex("sha3-512", `${requestId}${signatureTimestamp(isoTimestamp)}${signatureKey}`);
}

export function newRequestId(random: () => string): string {
  const id = `RID${random()}`.replace(/[^A-Za-z0-9_+]/g, "").slice(0, 30);
  if (id.length < 4) throw new NavProtocolError("a request id needs randomness");
  return id;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function envelope(
  op: NavOperation,
  body: string,
  c: NavCredentials,
  software: NavSoftware,
  ctx: { requestId: string; timestamp: string },
): string {
  if (!/^\d{8}$/.test(c.taxNumber))
    throw new NavProtocolError("the tax number is its first 8 digits");
  if (!/^[+a-zA-Z0-9_]{1,30}$/.test(ctx.requestId)) throw new NavProtocolError("bad request id");
  const sw = validateSoftware(software);
  const swXml = (
    [
      "softwareId",
      "softwareName",
      "softwareOperation",
      "softwareMainVersion",
      "softwareDevName",
      "softwareDevContact",
      "softwareDevCountryCode",
      "softwareDevTaxNumber",
    ] as const
  )
    .filter((k) => sw[k] !== undefined && sw[k] !== "")
    .map((k) => `<${k}>${esc(String(sw[k]))}</${k}>`)
    .join("");
  const root = `${op[0]!.toUpperCase()}${op.slice(1)}Request`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${root} xmlns:common="${COMMON_NS}" xmlns="${API_NS}">` +
    `<common:header><common:requestId>${ctx.requestId}</common:requestId>` +
    `<common:timestamp>${ctx.timestamp}</common:timestamp>` +
    `<common:requestVersion>3.0</common:requestVersion><common:headerVersion>1.0</common:headerVersion></common:header>` +
    `<common:user><common:login>${esc(c.login)}</common:login>` +
    `<common:passwordHash cryptoType="SHA-512">${passwordHash(c.password)}</common:passwordHash>` +
    `<common:taxNumber>${c.taxNumber}</common:taxNumber>` +
    `<common:requestSignature cryptoType="SHA3-512">${requestSignature(ctx.requestId, ctx.timestamp, c.signatureKey)}</common:requestSignature></common:user>` +
    `<software>${swXml}</software>` +
    body +
    `</${root}>`
  );
}

export type Direction = "OUTBOUND" | "INBOUND";

/** The three request bodies — the only requests SYB can build. */
export function buildRequest(
  req:
    | { op: "queryTaxpayer"; taxNumber: string }
    | { op: "queryInvoiceDigest"; page: number; direction: Direction; from: string; to: string }
    | {
        op: "queryInvoiceData";
        invoiceNumber: string;
        direction: Direction;
        supplierTaxNumber?: string;
      },
  c: NavCredentials,
  software: NavSoftware,
  ctx: { requestId: string; timestamp: string },
): string {
  switch (req.op) {
    case "queryTaxpayer":
      if (!/^\d{8}$/.test(req.taxNumber)) throw new NavProtocolError("a tax number is 8 digits");
      return envelope(req.op, `<taxNumber>${req.taxNumber}</taxNumber>`, c, software, ctx);
    case "queryInvoiceDigest": {
      const date = /^\d{4}-\d{2}-\d{2}$/;
      if (
        !date.test(req.from) ||
        !date.test(req.to) ||
        req.from > req.to ||
        req.from < "2010-01-01"
      ) {
        throw new NavProtocolError("a digest query names a date range from 2010 on");
      }
      if (!Number.isInteger(req.page) || req.page < 1)
        throw new NavProtocolError("pages start at 1");
      return envelope(
        req.op,
        `<page>${req.page}</page><invoiceDirection>${req.direction}</invoiceDirection>` +
          `<invoiceQueryParams><mandatoryQueryParams><invoiceIssueDate>` +
          `<dateFrom>${req.from}</dateFrom><dateTo>${req.to}</dateTo>` +
          `</invoiceIssueDate></mandatoryQueryParams></invoiceQueryParams>`,
        c,
        software,
        ctx,
      );
    }
    case "queryInvoiceData":
      return envelope(
        req.op,
        `<invoiceNumberQuery><invoiceNumber>${esc(req.invoiceNumber)}</invoiceNumber>` +
          `<invoiceDirection>${req.direction}</invoiceDirection>` +
          (req.supplierTaxNumber
            ? `<supplierTaxNumber>${req.supplierTaxNumber}</supplierTaxNumber>`
            : "") +
          `</invoiceNumberQuery>`,
        c,
        software,
        ctx,
      );
  }
}

// ── Reading responses ─────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 5_000_000;

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every element with this local name, any namespace prefix: its inner text. */
function all(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    "g",
  );
  const out: string[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(m[1]!);
  return out;
}

function one(xml: string, name: string): string | null {
  const v = all(xml, name)[0];
  return v === undefined ? null : unescape(v.trim());
}

export interface NavResult {
  ok: boolean;
  errorCode: string | null;
  message: string | null;
}

export function readResult(xml: string): NavResult {
  if (xml.length > MAX_RESPONSE_BYTES)
    throw new NavProtocolError("NAV's answer was larger than expected");
  const funcCode = one(xml, "funcCode");
  return { ok: funcCode === "OK", errorCode: one(xml, "errorCode"), message: one(xml, "message") };
}

export function readTaxpayer(xml: string): {
  valid: boolean;
  name: string | null;
  incorporation: string | null;
} {
  return {
    valid: one(xml, "taxpayerValidity") === "true",
    name: one(xml, "taxpayerName"),
    incorporation: one(xml, "incorporation"),
  };
}

/** "1234.5" in a currency → integer minor units, from its digits. Refuses more decimals than the currency has. */
export function decimalToMinor(raw: string, currency: string): number {
  const s = raw.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new NavProtocolError(`"${raw}" isn't an amount`);
  const digits = currencyRow(currency).minor_units;
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > digits)
    throw new NavProtocolError(`"${raw}" has more decimals than ${currency} has`);
  const minor = Number(`${m[2]}${frac.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(minor))
    throw new NavProtocolError(`"${raw}" is too large to hold exactly`);
  return m[1] === "-" && minor !== 0 ? -minor : minor;
}

export interface DigestItem {
  invoiceNumber: string;
  operation: "CREATE" | "MODIFY" | "STORNO";
  issueDate: string;
  supplierTaxNumber: string;
  customerTaxNumber: string | null;
  currency: string;
  net_minor: number;
  vat_minor: number;
  net_huf_minor: number | null;
}

export function readDigest(xml: string): {
  currentPage: number;
  availablePage: number;
  items: DigestItem[];
} {
  const items: DigestItem[] = [];
  for (const block of all(xml, "invoiceDigest")) {
    const currency = one(block, "currency") ?? "HUF";
    if (!isIsoCurrency(currency)) throw new NavProtocolError(`unknown currency ${currency}`);
    const op = one(block, "invoiceOperation");
    if (op !== "CREATE" && op !== "MODIFY" && op !== "STORNO") {
      throw new NavProtocolError("an invoice digest without its operation");
    }
    const netHuf = one(block, "invoiceNetAmountHUF");
    items.push({
      invoiceNumber: one(block, "invoiceNumber") ?? "",
      operation: op,
      issueDate: one(block, "invoiceIssueDate") ?? "",
      supplierTaxNumber: one(block, "supplierTaxNumber") ?? "",
      customerTaxNumber: one(block, "customerTaxNumber"),
      currency,
      net_minor: decimalToMinor(one(block, "invoiceNetAmount") ?? "0", currency),
      vat_minor: decimalToMinor(one(block, "invoiceVatAmount") ?? "0", currency),
      net_huf_minor: netHuf === null ? null : decimalToMinor(netHuf, "HUF"),
    });
  }
  return {
    currentPage: Number(one(xml, "currentPage") ?? "1"),
    availablePage: Number(one(xml, "availablePage") ?? "0"),
    items,
  };
}
