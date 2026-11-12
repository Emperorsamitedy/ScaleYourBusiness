// The NAV Online Számla connector — the multi-market spec Part E's tests:
//   · no NAV write/submit endpoint appears anywhere in the codebase
//   · NAV credentials never appear in captured log output
//   · buyer-side and issuer-side invoices both reach the normalised schema,
//     correctly distinguished as cost and revenue
// Against recorded-shape responses; no call reaches NAV.

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sideOf } from "../contract";
import type { NavTransport } from "./connector";
import { NAV_CONNECTOR, digestObservations, navConnector } from "./connector";
import type { NavCredentials, NavSoftware } from "./protocol";
import {
  NAV_OPERATIONS,
  buildRequest,
  decimalToMinor,
  passwordHash,
  readDigest,
  requestSignature,
  signatureTimestamp,
} from "./protocol";
import { installNavRedaction, redact } from "./redact";
import { navKeyFor, sealNavCredentials, withNavCredentials } from "./vault";

const CREDS: NavCredentials = {
  login: "techuser9x2k",
  password: "Pa55-word-very-secret",
  signatureKey: "sig-key-0123456789abcdef-XYZ",
  taxNumber: "12345678",
};
const SOFTWARE: NavSoftware = {
  softwareId: "HU12345678-SYB0001",
  softwareName: "SYB",
  softwareOperation: "ONLINE_SERVICE",
  softwareMainVersion: "1.0",
  softwareDevName: "SYB",
  softwareDevContact: "support@example.invalid",
};
const NOW = new Date("2026-11-10T12:34:56.789Z");

const ok = (body: string) =>
  `<?xml version="1.0"?><QueryResponse xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common"><ns2:header/><ns2:result><ns2:funcCode>OK</ns2:funcCode></ns2:result>${body}</QueryResponse>`;
const digest = (n: string, op: string, day: string, net: string, vat: string, currency = "HUF") =>
  `<invoiceDigest><invoiceNumber>${n}</invoiceNumber><invoiceOperation>${op}</invoiceOperation><invoiceCategory>NORMAL</invoiceCategory><invoiceIssueDate>${day}</invoiceIssueDate><supplierTaxNumber>12345678</supplierTaxNumber><supplierName>X</supplierName><currency>${currency}</currency><invoiceNetAmount>${net}</invoiceNetAmount><invoiceNetAmountHUF>${net}</invoiceNetAmountHUF><invoiceVatAmount>${vat}</invoiceVatAmount><invoiceVatAmountHUF>${vat}</invoiceVatAmountHUF><insDate>2026-11-02T10:00:00Z</insDate></invoiceDigest>`;

function fakeNav(): { transport: NavTransport; calls: { url: string; xml: string }[] } {
  const calls: { url: string; xml: string }[] = [];
  const transport: NavTransport = async (url, xml) => {
    calls.push({ url, xml });
    if (url.endsWith("/queryTaxpayer")) {
      return {
        status: 200,
        text: ok(
          "<taxpayerValidity>true</taxpayerValidity><taxpayerData><taxpayerName>Rózsa Kávézó Kft.</taxpayerName><incorporation>ORGANIZATION</incorporation></taxpayerData>",
        ),
      };
    }
    const outbound = xml.includes("<invoiceDirection>OUTBOUND</invoiceDirection>");
    const november = xml.includes("<dateFrom>2026-11-01</dateFrom>");
    const items = !november
      ? ""
      : outbound
        ? digest("A-1", "CREATE", "2026-11-02", "100000", "27000") +
          digest("A-2", "CREATE", "2026-11-02", "25000.50", "6750") +
          digest("A-3", "STORNO", "2026-11-03", "-100000", "-27000")
        : digest("B-1", "CREATE", "2026-11-02", "40000", "10800");
    return {
      status: 200,
      text: ok(
        `<invoiceDigestResult><currentPage>1</currentPage><availablePage>1</availablePage>${items}</invoiceDigestResult>`,
      ),
    };
  };
  return { transport, calls };
}

function connector(transport: NavTransport) {
  return navConnector({
    withCredentials: async (work) => work(CREDS),
    software: SOFTWARE,
    environment: "test",
    transport,
    now: () => NOW,
    random: () => "abc123",
  });
}

describe("§E.2 — signing as NAV specifies it", () => {
  it("hashes the password with SHA-512 and signs with SHA3-512, upper-case hex", () => {
    expect(passwordHash("x")).toBe(createHash("sha512").update("x").digest("hex").toUpperCase());
    expect(signatureTimestamp("2026-11-10T12:34:56.789Z")).toBe("20261110123456");
    expect(requestSignature("RID1", "2026-11-10T12:34:56.789Z", "k")).toBe(
      createHash("sha3-512").update("RID120261110123456k").digest("hex").toUpperCase(),
    );
  });

  it("builds a query envelope with header, user and software in order — never the plain password", () => {
    const xml = buildRequest({ op: "queryTaxpayer", taxNumber: "12345678" }, CREDS, SOFTWARE, {
      requestId: "RID1",
      timestamp: NOW.toISOString(),
    });
    expect(xml).toMatch(/^<\?xml[^>]+\?><QueryTaxpayerRequest /);
    expect(xml.indexOf("<common:header>")).toBeLessThan(xml.indexOf("<common:user>"));
    expect(xml.indexOf("<common:user>")).toBeLessThan(xml.indexOf("<software>"));
    expect(xml).toContain('<common:passwordHash cryptoType="SHA-512">');
    expect(xml).toContain('<common:requestSignature cryptoType="SHA3-512">');
    expect(xml).not.toContain(CREDS.password);
    expect(xml).not.toContain(CREDS.signatureKey);
  });

  it("refuses a malformed software id, tax number or date range", () => {
    const ctx = { requestId: "RID1", timestamp: NOW.toISOString() };
    expect(() =>
      buildRequest(
        { op: "queryTaxpayer", taxNumber: "12345678" },
        CREDS,
        { ...SOFTWARE, softwareId: "short" },
        ctx,
      ),
    ).toThrow(/18 characters/);
    expect(() =>
      buildRequest({ op: "queryTaxpayer", taxNumber: "1234" }, CREDS, SOFTWARE, ctx),
    ).toThrow(/8 digits/);
    expect(() =>
      buildRequest(
        {
          op: "queryInvoiceDigest",
          page: 1,
          direction: "OUTBOUND",
          from: "2026-11-30",
          to: "2026-11-01",
        },
        CREDS,
        SOFTWARE,
        ctx,
      ),
    ).toThrow(/date range/);
  });

  it("reads amounts from their digits — no float", () => {
    expect(decimalToMinor("25000.50", "HUF")).toBe(2_500_050);
    expect(decimalToMinor("-100000", "HUF")).toBe(-10_000_000);
    expect(decimalToMinor("0.1", "EUR")).toBe(10);
    expect(() => decimalToMinor("1.234", "HUF")).toThrow(/more decimals/);
    expect(() => decimalToMinor("1e5", "HUF")).toThrow();
  });
});

describe("§E.3 — both sides reach the normalised schema, told apart", () => {
  it("issuer-side invoices are revenue and buyer-side are cost, net of VAT, graded B", async () => {
    const { transport } = fakeNav();
    const events = await connector(transport).pull("2026-11-01");
    const revenue = events.filter((e) => sideOf(e.metric) === "revenue");
    const cost = events.filter((e) => sideOf(e.metric) === "cost");
    expect(revenue.map((e) => [e.day, e.amount])).toEqual([
      ["2026-11-02", { amount_minor: 12_500_050, currency: "HUF" }],
      ["2026-11-03", { amount_minor: -10_000_000, currency: "HUF" }], // the storno
    ]);
    expect(cost.map((e) => [e.day, e.amount])).toEqual([
      ["2026-11-02", { amount_minor: 4_000_000, currency: "HUF" }],
    ]);
    for (const e of events) {
      expect(e.grade).toBe("B");
      expect(e.source).toBe("measured");
    }
  });

  it("is the same shape as any other connector's events", async () => {
    const { transport } = fakeNav();
    const [e] = await connector(transport).pull("2026-11-01");
    expect(Object.keys(e!).sort()).toEqual(
      [
        "amount",
        "day",
        "dimensions",
        "grade",
        "id",
        "metric",
        "observed_at",
        "quantity",
        "source",
        "source_detail",
      ].sort(),
    );
    expect(e!.id).not.toContain(NAV_CONNECTOR); // ids are hashes, not provider-tagged strings
  });

  it("sums a day per currency, and keeps currencies apart", () => {
    const items = readDigest(
      ok(
        digest("1", "CREATE", "2026-11-02", "10", "0", "EUR") +
          digest("2", "CREATE", "2026-11-02", "1000", "0"),
      ),
    ).items;
    const obs = digestObservations(items, "OUTBOUND", NOW.toISOString());
    expect(obs.map((o) => [o.dimensions.currency, o.value_minor]).sort()).toEqual([
      ["EUR", 1_000],
      ["HUF", 100_000],
    ]);
  });
});

describe("§E.4 — onboarding validates at once and names the business back", () => {
  it("authorize runs queryTaxpayer and holds the read operations only", async () => {
    const { transport, calls } = fakeNav();
    expect(await connector(transport).authorize()).toEqual({
      ok: true,
      scopes_held: [...NAV_OPERATIONS],
    });
    expect(calls[0]!.url).toBe(
      "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer",
    );
  });

  it("a rejected technical user fails in plain words, not a code", async () => {
    const c = connector(async () => ({
      status: 200,
      text: `<r><funcCode>ERROR</funcCode><errorCode>INVALID_SECURITY_USER</errorCode></r>`,
    }));
    const result = await c.authorize();
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/technical user/) });
    expect(JSON.stringify(result)).not.toMatch(/INVALID_SECURITY_USER/);
    expect((await c.health()).status).toBe("degraded");
  });

  it("has no push — not stubbed, absent", () => {
    expect("push" in connector(fakeNav().transport)).toBe(false);
  });
});

describe("§E.5 — credentials: per-business keys, never in a log", () => {
  const master = randomBytes(32);
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";

  it("each business has its own key; a blob doesn't open under another account", async () => {
    expect(navKeyFor(a, master).equals(navKeyFor(b, master))).toBe(false);
    const blob = sealNavCredentials(a, CREDS, master);
    expect(blob).not.toContain(CREDS.password);
    await expect(withNavCredentials(b, blob, async (c) => c, master)).rejects.toThrow();
    expect(await withNavCredentials(a, blob, async (c) => c.login, master)).toBe(CREDS.login);
  });

  afterEach(() => vi.restoreAllMocks());

  it("NAV credentials never appear in captured log output", async () => {
    const captured: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(
          args
            .map((x) =>
              typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x),
            )
            .join(" "),
        );
      });
    }
    installNavRedaction();
    const blob = sealNavCredentials(a, CREDS, master);
    const leaky: NavTransport = async (_url, xml) => {
      // A careless transport that logs the whole request, and an error carrying it.
      console.log("sending", xml);
      console.error(new Error(`failed: ${xml}`));
      console.warn({ body: xml, password: CREDS.password });
      return { status: 500, text: "<r><funcCode>ERROR</funcCode></r>" };
    };
    const c = navConnector({
      withCredentials: (work) => withNavCredentials(a, blob, work, master),
      software: SOFTWARE,
      environment: "test",
      transport: leaky,
      now: () => NOW,
      random: () => "abc",
    });
    await c.authorize();
    const out = captured.join("\n");
    expect(out.length).toBeGreaterThan(0);
    for (const secret of [
      CREDS.password,
      CREDS.signatureKey,
      CREDS.login,
      passwordHash(CREDS.password),
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toMatch(/<common:requestSignature[^>]*>[0-9A-F]{128}</);
  });

  it("redact strips NAV auth elements even when no credential is live", () => {
    expect(redact('<common:passwordHash cryptoType="SHA-512">ABC</common:passwordHash>')).toBe(
      '<common:passwordHash cryptoType="SHA-512">[redacted]</common:passwordHash>',
    );
  });
});

// §E.5: "Scoped in code to read-only query operations. manage_invoice and
// every write operation must be unreachable." Proven by scanning the source.
const ROOT = path.resolve(__dirname, "../../..");
const FORBIDDEN = [
  /manageInvoice/i,
  /manage_invoice/i,
  /manageAnnulment/i,
  /tokenExchange/i,
  /exchangeKey/i,
  /queryTransactionStatus/i,
];

function sources(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...sources(path.relative(ROOT, p)));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("§E.5 — no NAV write or submit operation exists anywhere", () => {
  it("the source names no write-side NAV operation", () => {
    const hits = ["lib", "app", "components", "scripts"]
      .flatMap(sources)
      .filter((f) => FORBIDDEN.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
    // A whole-repo scan: slow under a full parallel run, so it gets its own limit.
  }, 120_000);

  it("the protocol's operations are the three reads, and nothing else", () => {
    expect([...NAV_OPERATIONS]).toEqual([
      "queryTaxpayer",
      "queryInvoiceDigest",
      "queryInvoiceData",
    ]);
  });
});
