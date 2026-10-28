// Phase 5 Session C — P5-11..13 as tests, the pure half. What must hold:
//
//   · READ-ONLY, PROVEN (rule 30). No source in lib/site/audit names a
//     write verb or sets a method other than GET; every PageSpeed call is a
//     GET with the key in a header, never in the URL; the walk never opens
//     a login page, a cart action link or checkout, and never fetches a page
//     on another company's site.
//   · HONEST NUMBERS. Field data where Google has it, else lab, and the
//     finding says which; CrUX's CLS ×100 is undone; lab has no INP.
//   · STATED THRESHOLDS. Severities come from SITE_THRESHOLDS, tested at
//     the boundaries both ways.
//   · RULE 25. A € figure only with the owner's own traffic and conversion,
//     as a range naming what it assumes; otherwise "not computed".

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESEARCH_SOURCE_REGISTRY, auditRegistry } from "../../connectors/scopes";
import type { OwnerSiteFigures } from "./findings";
import {
  SITE_AUDIT_KEY,
  SITE_THRESHOLDS,
  rate,
  siteFindings,
  speedEuro,
  toDiagnosisFindings,
  vitalSeverity,
} from "./findings";
import {
  classifyLink,
  countForms,
  firstScreenText,
  hasAddToCart,
  pageLinks,
  showsPrice,
} from "./links";
import {
  PAGESPEED_CAPS,
  PageSpeedError,
  createPageSpeedClient,
  pagespeedUrl,
  parseFieldData,
  parsePageSpeed,
} from "./pagespeed";
import {
  FAKE_PAGESPEED_KEY,
  fakePageSpeed,
  pagespeedBody,
  pagespeedError,
  pagespeedJson,
} from "./pagespeed-fake";
import { SHOP, SHOP_PAGES, shopFetcher } from "./shop-fixture";
import { keyPages, walkSite } from "./walk";

const noSleep = async () => undefined;
const dir = fileURLToPath(new URL(".", import.meta.url));

describe("P5-12 / rule 30 — read-only, proven", () => {
  it("THE BUILD GATE: no source in this module names a write verb or sets any method but GET", () => {
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toEqual(
      expect.arrayContaining([
        "pagespeed.ts",
        "pagespeed-fake.ts",
        "walk.ts",
        "links.ts",
        "findings.ts",
        "service.ts",
        "view.ts",
        "shop-fixture.ts",
      ]),
    );
    for (const file of sources) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      expect(source, file).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
      expect(source, file).not.toMatch(/[?&]key=/);
      for (const m of source.matchAll(/method:\s*([^,;\n}]+)/g)) {
        expect(['"GET"', "init.method"], file).toContain(m[1]?.trim());
      }
    }
    // The page reader it walks with sets no method at all: undici's default, GET.
    const fetchSource = readFileSync(`${dir}../fetch.ts`, "utf8");
    expect(fetchSource).not.toMatch(/method:/);
  });

  it("PageSpeed is in the research registry with no scope, and the audit stays clean", () => {
    expect(RESEARCH_SOURCE_REGISTRY.pagespeed_insights).toEqual([]);
    expect(auditRegistry()).toEqual([]);
  });

  it("every PageSpeed call is a GET to the one path, the key in a header and never the URL", async () => {
    const fake = fakePageSpeed({ key: FAKE_PAGESPEED_KEY });
    const client = createPageSpeedClient({
      apiKey: FAKE_PAGESPEED_KEY,
      fetch: fake.fetch,
      maxRequests: 4,
    });
    await client.run(`${SHOP}/`, "mobile");
    await client.run(`${SHOP}/`, "desktop");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe("https://www.googleapis.com");
      expect(call.url.pathname).toBe("/pagespeedonline/v5/runPagespeed");
      expect(call.url.href).not.toContain(FAKE_PAGESPEED_KEY);
      expect(call.url.searchParams.has("key")).toBe(false);
      expect(call.init.headers["x-goog-api-key"]).toBe(FAKE_PAGESPEED_KEY);
      expect(call.url.searchParams.getAll("category")).toEqual(["performance", "accessibility"]);
    }
    expect(fake.calls.map((c) => c.url.searchParams.get("strategy"))).toEqual([
      "mobile",
      "desktop",
    ]);
  });

  it("keyless calls send no key at all and say the shared quota is spent when it is", async () => {
    const fake = fakePageSpeed({ respond: () => pagespeedError(429, "Quota exceeded") });
    const client = createPageSpeedClient({
      apiKey: null,
      fetch: fake.fetch,
      maxRequests: 10,
      sleep: noSleep,
    });
    const error = await client.run(`${SHOP}/`, "mobile").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageSpeedError);
    expect((error as PageSpeedError).kind).toBe("quota");
    expect((error as Error).message).toMatch(/shared PageSpeed quota/);
    expect(fake.calls).toHaveLength(PAGESPEED_CAPS.max_attempts);
    expect(fake.calls[0]?.init.headers["x-goog-api-key"]).toBeUndefined();
  });

  it("never makes more requests than its budget", async () => {
    const fake = fakePageSpeed();
    const client = createPageSpeedClient({ apiKey: null, fetch: fake.fetch, maxRequests: 1 });
    await client.run(`${SHOP}/`, "mobile");
    await expect(client.run(`${SHOP}/`, "desktop")).rejects.toThrow(/calls for the site are used/);
    expect(fake.calls).toHaveLength(1);
  });

  it("the walk never opens login, cart actions, checkout or another site's pages", async () => {
    const fetcher = shopFetcher();
    const walk = await walkSite(`${SHOP}/`, fetcher);
    for (const url of fetcher.asked) {
      expect(url).not.toMatch(/\/account|\/login|\/cart\/add|\/checkout/);
      expect(new URL(url).origin).toBe(SHOP);
    }
    const refused = Object.fromEntries(
      walk.refused.map((r) => [new URL(r.url).pathname, r.reason]),
    );
    expect(refused["/account/login"]).toBe("login_or_account");
    expect(refused["/cart/add"]).toBe("cart_action");
    expect(refused["/checkout"]).toBe("checkout");
  });
});

describe("P5-11 — reading what Google answers", () => {
  it("undoes CrUX's CLS ×100, reads INP under either name, and marks a whole-site fallback", () => {
    const field = parseFieldData({
      origin_fallback: true,
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: "AVERAGE" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
        EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      },
    });
    expect(field).toEqual({
      lcp_ms: { p75: 3100, category: "AVERAGE" },
      cls: { p75: 0.12, category: "AVERAGE" },
      inp_ms: { p75: 180, category: "FAST" },
      origin_fallback: true,
    });
    expect(parseFieldData({ metrics: {} })).toBeNull();
    expect(parseFieldData(undefined)).toBeNull();
  });

  it("reads the lab audits, with an unrun audit unknown rather than zero (rule 5)", () => {
    const body = pagespeedBody(
      `${SHOP}/`,
      "mobile",
      {
        lcp_ms: 5200,
        cls: 0.3,
        tbt_ms: 700,
        page_bytes: 4_200_000,
        performance: 0.41,
        contrast_failures: 3,
      },
      "2026-10-27T08:00:00.000Z",
    );
    const r = parsePageSpeed(body, `${SHOP}/`, "mobile", false, new Date("2026-10-27T09:00:00Z"));
    expect(r.field).toBeNull();
    expect(r.lab).toEqual({
      lcp_ms: 5200,
      cls: 0.3,
      tbt_ms: 700,
      page_bytes: 4_200_000,
      performance_score: 41,
      contrast_failures: 3,
      tap_target_failures: null,
    });
    expect(r.provenance).toMatchObject({
      source: "pagespeed_insights",
      measured_at: "2026-10-27T08:00:00.000Z",
      lighthouse_version: "12.2.1",
      keyed: false,
    });
  });

  it("refuses a Lighthouse runtime error and a failed page load in words", async () => {
    expect(() =>
      parsePageSpeed(
        { lighthouseResult: { runtimeError: { code: "FAILED_DOCUMENT_REQUEST" } } },
        SHOP,
        "mobile",
        false,
        new Date(),
      ),
    ).toThrow(/couldn't load the page/);
    const fake = fakePageSpeed({
      respond: () => pagespeedError(400, "Lighthouse returned error: FAILED_DOCUMENT_REQUEST"),
    });
    const client = createPageSpeedClient({ apiKey: null, fetch: fake.fetch, maxRequests: 5 });
    await expect(client.run(SHOP, "mobile")).rejects.toThrow(/couldn't load the page/);
    expect(fake.calls).toHaveLength(1); // a page error is not retried
  });

  it("retries a 5xx once, then succeeds", async () => {
    const fake = fakePageSpeed({
      respond: (_, n) => (n === 1 ? pagespeedJson(503, {}) : null),
    });
    const client = createPageSpeedClient({
      apiKey: null,
      fetch: fake.fetch,
      maxRequests: 5,
      sleep: noSleep,
    });
    const r = await client.run(`${SHOP}/`, "desktop");
    expect(r.strategy).toBe("desktop");
    expect(client.requests).toBe(2);
  });

  it("the URL carries the page, the strategy and the categories — nothing else", () => {
    const url = new URL(pagespeedUrl("https://a.example/x?y=1", "mobile"));
    expect([...url.searchParams.keys()].sort()).toEqual([
      "category",
      "category",
      "strategy",
      "url",
    ]);
    expect(url.searchParams.get("url")).toBe("https://a.example/x?y=1");
  });
});

describe("P5-12 — reading a page like a visitor", () => {
  const base = new URL(`${SHOP}/`);
  const role = (path: string, text = "") => classifyLink(new URL(path, base), text, base);

  it("classifies links by what they are, and refuses the three kinds rule 30 names", () => {
    expect(role("/products/mug")).toMatchObject({ role: "product", never_follow: null });
    expect(role("/collections/mugs/products/mug").role).toBe("product");
    expect(role("/collections/mugs").role).toBe("category");
    expect(role("/cart")).toMatchObject({ role: "cart", never_follow: null });
    expect(role("/cart/add?id=3").never_follow).toBe("cart_action");
    expect(role("/?add-to-cart=12").never_follow).toBe("cart_action");
    expect(role("/checkout")).toMatchObject({ role: "checkout", never_follow: "checkout" });
    expect(role("/account/login").never_follow).toBe("login_or_account");
    expect(role("/wp-login.php").never_follow).toBe("login_or_account");
    expect(role("/my-account").never_follow).toBe("login_or_account");
    expect(role("/book-now").role).toBe("booking");
    expect(role("/x", "Book now").role).toBe("booking");
    expect(role("/pages/contact").role).toBe("contact");
    expect(role("/kapcsolat").role).toBe("contact");
    expect(role("/services/colour").role).toBe("service");
    expect(role("/books").role).toBe("other"); // a bookshop's page, not a booking
    expect(classifyLink(new URL("https://www.fresha.com/a/salon"), "Book", base)).toMatchObject({
      role: "booking",
      same_origin: false,
      never_follow: "external_booking",
    });
    expect(classifyLink(new URL("https://instagram.com/x"), "", base).role).toBe("other");
  });

  it("lists each address once, without fragments or mail links", () => {
    const links = pageLinks(
      `<a href="/a#top">A</a><a href="/a">A again</a><a href="mailto:x@y.z">mail</a><a href="#x">jump</a><a href="tel:1">t</a>`,
      `${SHOP}/`,
    );
    expect(links.map((l) => l.url)).toEqual([`${SHOP}/a`]);
  });

  it("finds a price in the first screen, after the header and menu, by heuristic", () => {
    expect(showsPrice("Mugs from €34")).toBe(true);
    expect(showsPrice("34,00 €")).toBe(true);
    expect(showsPrice("12 900 Ft")).toBe(true);
    expect(showsPrice("£8.50 each")).toBe(true);
    expect(showsPrice("EUR 20")).toBe(true);
    expect(showsPrice("We opened in 2019 with 3 kilns")).toBe(false);
    const html = `<body><header><nav>Shop €0 delivery</nav></header><main><h1>Mug</h1><p>${"words ".repeat(150)}</p><p>&euro;34</p></main></body>`;
    expect(showsPrice(firstScreenText(html))).toBe(false);
    expect(
      showsPrice(firstScreenText(`<body><main><h1>Mug</h1><p>&euro;34.00</p></main></body>`)),
    ).toBe(true);
  });

  it("counts the fields a visitor fills in, skipping hidden inputs, buttons, search and cart forms", () => {
    const forms = countForms(SHOP_PAGES[`${SHOP}/pages/contact`] as string);
    expect(forms).toEqual([{ action: "/contact", fields: 9, required: 2 }]);
    expect(countForms(`<form action="/cart/add"><input name="qty"></form>`)).toEqual([]);
    expect(hasAddToCart(SHOP_PAGES[`${SHOP}/products/big-bowl`] as string)).toBe(true);
    expect(hasAddToCart("<p>Sold out</p>")).toBe(false);
  });
});

describe("P5-12 — the path to buying", () => {
  it("counts clicks from home to checkout through a product and its Add to cart, stating the assumption", async () => {
    const walk = await walkSite(`${SHOP}/`, shopFetcher());
    expect(walk.platform?.platform).toBe("shopify");
    expect(walk.path.kind).toBe("shop");
    // home → Shop all (1) → Blue bowl (2) → Add to cart (3) → Checkout (4)
    expect(walk.path.clicks).toBe(4);
    expect(walk.path.steps.map((s) => s.kind)).toEqual([
      "page",
      "page",
      "page",
      "control",
      "entry",
    ]);
    expect(walk.path.notes.some((n) => n.startsWith("ASSUMED"))).toBe(true);
    const blue = walk.pages.find((p) => p.url.endsWith("/blue-bowl"));
    expect(blue?.price_first_screen).toBe(false);
    expect(walk.pages.find((p) => p.url.endsWith("/big-bowl"))?.price_first_screen).toBe(true);
    expect(walk.pages.find((p) => p.role === "contact")?.forms?.[0]?.fields).toBe(9);
    expect(walk.broken.map((b) => new URL(b.url).pathname)).toEqual(["/collections/sale"]);
    expect(walk.broken[0]?.on_path).toBe(true);
  });

  it("picks the home page and up to four key pages, checkout never", async () => {
    const walk = await walkSite(`${SHOP}/`, shopFetcher());
    const picks = keyPages(walk, 5);
    expect(picks.map((p) => p.role)).toEqual(["home", "product", "cart", "contact", "category"]);
    expect(picks.some((p) => /checkout/.test(p.url))).toBe(false);
    expect(keyPages(walk, 2)).toHaveLength(2);
  });

  it("stops at a booking link on another company's site, without reading it", async () => {
    const salon = "https://audit-salon.example";
    const pages = {
      [`${salon}/`]: `<html><body><main><h1>Salon</h1><a href="/services">Services</a></main></body></html>`,
      [`${salon}/services`]: `<html><body><main><h1>Cuts €45</h1><a href="https://www.fresha.com/a/salon-x">Book now</a></main></body></html>`,
    };
    const fetcher = shopFetcher(pages);
    const walk = await walkSite(`${salon}/`, fetcher);
    expect(walk.path.kind).toBe("booking");
    expect(walk.path.clicks).toBe(2);
    expect(fetcher.asked.every((u) => u.startsWith(salon))).toBe(true);
    expect(walk.refused).toEqual([
      { url: "https://www.fresha.com/a/salon-x", reason: "external_booking" },
    ]);
  });

  it("says when the home page can't be read, and reads nothing further", async () => {
    const fetcher = shopFetcher({});
    await expect(walkSite(`${SHOP}/`, fetcher)).rejects.toThrow(/answered 404/);
    expect(fetcher.asked).toHaveLength(1);
  });

  it("stays inside its read cap", async () => {
    const fetcher = shopFetcher();
    const walk = await walkSite(`${SHOP}/`, fetcher, { max_reads: 2, max_link_checks: 1 });
    expect(walk.pages).toHaveLength(2);
    expect(fetcher.asked.length).toBeLessThanOrEqual(3);
  });
});

describe("P5-13 — stated thresholds, at the boundaries", () => {
  it("rates vitals in Google's bands, inclusive on the good side", () => {
    const lcp = SITE_THRESHOLDS.lcp_ms;
    expect(rate(2500, lcp)).toBe("good");
    expect(rate(2501, lcp)).toBe("needs_improvement");
    expect(rate(4000, lcp)).toBe("needs_improvement");
    expect(rate(4001, lcp)).toBe("poor");
    expect(rate(0.1, SITE_THRESHOLDS.cls)).toBe("good");
    expect(rate(0.26, SITE_THRESHOLDS.cls)).toBe("poor");
    expect(rate(200, SITE_THRESHOLDS.inp_ms)).toBe("good");
    expect(rate(501, SITE_THRESHOLDS.inp_ms)).toBe("poor");
  });

  it("weighs phones above computers", () => {
    expect(vitalSeverity("good", "mobile")).toBeNull();
    expect(vitalSeverity("poor", "mobile")).toBe("high");
    expect(vitalSeverity("needs_improvement", "mobile")).toBe("medium");
    expect(vitalSeverity("poor", "desktop")).toBe("medium");
    expect(vitalSeverity("needs_improvement", "desktop")).toBe("low");
  });

  const speedFor = (mobile: Parameters<typeof pagespeedBody>[2], url = `${SHOP}/`) =>
    parsePageSpeed(
      pagespeedBody(url, "mobile", mobile, "2026-10-27T08:00:00.000Z"),
      url,
      "mobile",
      true,
      new Date(),
    );

  it("prefers field data to lab, and says which", async () => {
    const walk = await walkSite(`${SHOP}/`, shopFetcher());
    const fieldOnly = siteFindings({
      walk,
      speed: [
        speedFor({
          lcp_ms: 1500,
          cls: 0,
          tbt_ms: 50,
          page_bytes: 1e6,
          performance: 0.9,
          field: { lcp_ms: 4600, cls: 0.02, inp_ms: 150 },
        }),
      ],
      figures: null,
      measured_at: "2026-10-27T08:00:00.000Z",
    });
    const lcp = fieldOnly.find((f) => f.code === "lcp_slow");
    expect(lcp).toMatchObject({
      kind: "measured",
      severity: "high",
      evidence: { basis: "field", value: 4600, screenshot: null },
    });
    // Lab says 1.5 s; the real visitors said 4.6 s — the finding is the visitors'.
    const labOnly = siteFindings({
      walk,
      speed: [speedFor({ lcp_ms: 3000, cls: 0, tbt_ms: 650, page_bytes: 1e6, performance: 0.7 })],
      figures: null,
      measured_at: "2026-10-27T08:00:00.000Z",
    });
    expect(labOnly.find((f) => f.code === "lcp_slow")).toMatchObject({
      severity: "medium",
      evidence: { basis: "lab" },
    });
    // No field INP: the lab stand-in speaks, never above medium.
    expect(labOnly.find((f) => f.code === "tbt_slow")?.severity).toBe("medium");
    expect(labOnly.some((f) => f.code === "inp_slow")).toBe(false);
  });

  it("page weight, the path, the price, the form and the broken link each have their stated line", async () => {
    const walk = await walkSite(`${SHOP}/`, shopFetcher());
    const findings = siteFindings({
      walk,
      speed: [
        speedFor({
          lcp_ms: 2000,
          cls: 0,
          tbt_ms: 50,
          page_bytes: 6_000_001,
          performance: 0.9,
          tap_target_failures: 5,
        }),
      ],
      figures: null,
      measured_at: "2026-10-27T08:00:00.000Z",
    });
    const by = (code: string) => findings.find((f) => f.code === code);
    expect(by("page_heavy")?.severity).toBe("high");
    expect(by("tap_targets")?.severity).toBe("medium");
    expect(by("path_long")).toBeUndefined(); // 4 clicks is inside the shop's line
    expect(by("price_hidden")?.severity).toBe("medium");
    expect(by("form_long")?.severity).toBe("high"); // 9 fields
    expect(by("broken_link")?.severity).toBe("high");
    expect(findings.every((f) => f.kind === "measured" && f.threshold.length > 0)).toBe(true);
    // Severest first.
    const ranks = findings.map((f) => ["critical", "high", "medium", "low"].indexOf(f.severity));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const light = siteFindings({
      walk,
      speed: [
        speedFor({ lcp_ms: 2000, cls: 0, tbt_ms: 50, page_bytes: 3_000_000, performance: 0.9 }),
      ],
      figures: null,
      measured_at: "x",
    });
    expect(light.some((f) => f.code === "page_heavy")).toBe(false);
  });
});

describe("P5-13 / rule 25 — the € figure", () => {
  const figures: OwnerSiteFigures = {
    sessions_per_month: 4000,
    orders_per_month: 80,
    aov_minor: 4500,
    currency: "EUR",
    basis: "measured",
    window: "your connectors' last month, as of 2026-10-26",
    sources: ["visits: measured (presence.monthly_sessions)"],
  };

  it("is not computed without the owner's own traffic and conversion, and says what is missing", () => {
    expect(speedEuro(5000, null)).toEqual({
      computed: false,
      why: "not computed — it needs your own site traffic and conversion",
    });
    const missing = speedEuro(5000, { missing: "no monthly website visits of your own" });
    expect(missing.computed).toBe(false);
    expect(!missing.computed && missing.why).toMatch(/monthly website visits/);
  });

  it("is a range from the owner's figures, naming every assumption", () => {
    const euro = speedEuro(4500, figures);
    expect(euro.computed).toBe(true);
    if (!euro.computed) return;
    // 80 orders × €45 = €3,600 a month; 2.0 s over; 1–4% a second → €72–€288.
    expect(euro.low_minor).toBe(7200);
    expect(euro.high_minor).toBe(28800);
    expect(euro.low_minor).toBeLessThan(euro.high_minor);
    expect(euro.assumed.every((a) => a.startsWith("ASSUMED"))).toBe(true);
    expect(euro.assumed[0]).toMatch(/rule of thumb.*not measured on your site/);
    expect(euro.formula).toMatch(/4000 visits × 2\.0% conversion/);
    expect(euro.window).toBe(figures.window);
  });

  it("counts at most the stated seconds", () => {
    const capped = speedEuro(20_000, figures);
    const three = speedEuro(5500, figures);
    expect(capped).toEqual(three);
  });

  it("the report's findings cite the audit fact, are marked measured, and carry the € line", async () => {
    const walk = await walkSite(`${SHOP}/`, shopFetcher());
    const findings = siteFindings({
      walk,
      speed: [
        parsePageSpeed(
          pagespeedBody(
            `${SHOP}/`,
            "mobile",
            { lcp_ms: 4500, cls: 0, tbt_ms: 50, page_bytes: 1e6, performance: 0.6 },
            "2026-10-27T08:00:00.000Z",
          ),
          `${SHOP}/`,
          "mobile",
          true,
          new Date(),
        ),
      ],
      figures,
      measured_at: "2026-10-27T08:00:00.000Z",
    });
    const report = toDiagnosisFindings(findings, (m, c) => `${(m / 100).toFixed(0)} ${c}`);
    expect(report.length).toBeGreaterThan(0);
    expect(report.length).toBeLessThanOrEqual(4);
    for (const f of report) {
      expect(f.evidence).toEqual([SITE_AUDIT_KEY]);
      expect(f.kind).toBe("measured");
      expect(["critical", "high", "medium"]).toContain(f.severity);
    }
    const speed = report.find((f) => /main content takes/.test(f.title));
    expect(speed?.detail).toMatch(/about 72 EUR–288 EUR a month at stake/);
    expect(report.find((f) => /broken/.test(f.title))?.detail).toMatch(/not computed/);
  });
});
