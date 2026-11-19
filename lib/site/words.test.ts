// L-4c: the website screen's server-built sentences. English is held to
// what the code said before L-4, byte for byte (the stored rows are that
// English); German, Russian and Chinese are said again at presentation
// from the same structure, and a stored sentence SYB's English no longer
// reproduces is shown as stored.

import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { CHECKS, checkLabel } from "../blindspots/checks";
import { localeTr } from "../i18n/request-tr";
import type { Tr } from "../i18n/tr";
import type { OwnerSiteFigures } from "./audit/findings";
import { siteFindings, speedEuro } from "./audit/findings";
import type { PageSpeedResult, Strategy } from "./audit/pagespeed";
import { NO_KEY_NOTE } from "./audit/service";
import { SHOP, shopFetcher } from "./audit/shop-fixture";
import type { SiteAuditView } from "./audit/view";
import { NEVER_LINES, NOT_BUILT } from "./audit/view";
import { walkSite } from "./audit/walk";
import { buildManualInstructions, siteChangeWords, siteRefusal } from "./changes";
import {
  checkWords,
  localizeEuro,
  localizeFailure,
  localizeSiteAudit,
  localizeSiteProposal,
  siteErrorWords,
} from "./localize";
import { detectPlatform, editabilityLine } from "./platform";
import type { PlatformVerdict } from "./platform";
import { joinSentences, parseStored, sayStored, siteEnglish } from "./say";

const EN = siteEnglish();
let de: Tr = EN;
let ru: Tr = EN;
let zh: Tr = EN;
beforeAll(async () => {
  [de, ru, zh] = await Promise.all([
    localeTr("de-DE", "siteWords"),
    localeTr("ru-RU", "siteWords"),
    localeTr("zh-Hans", "siteWords"),
  ]);
});

const SHOPIFY: PlatformVerdict = {
  platform: "shopify",
  editable: "api",
  marker: "Shopify CDN/theme object",
};
const WIX: PlatformVerdict = { platform: "wix", editable: "manual", marker: "Wix static assets" };

function result(
  url: string,
  strategy: Strategy,
  lab: Partial<PageSpeedResult["lab"]>,
): PageSpeedResult {
  return {
    page_url: url,
    strategy,
    field: null,
    lab: {
      lcp_ms: 1200,
      cls: 0,
      tbt_ms: 50,
      page_bytes: 1_000_000,
      performance_score: 90,
      contrast_failures: 0,
      tap_target_failures: 0,
      ...lab,
    },
    provenance: {
      source: "pagespeed_insights",
      api: "v5 runPagespeed",
      measured_at: "2026-10-27T08:00:00.000Z",
      lighthouse_version: "12",
      final_url: url,
      keyed: true,
    },
  };
}

const HOME = `${SHOP}/`;
const BOWL = `${SHOP}/products/blue-bowl`;
const SPEED = [
  result(HOME, "mobile", { lcp_ms: 5200, page_bytes: 4_500_000, tap_target_failures: 3 }),
  result(BOWL, "mobile", { lcp_ms: 3000 }),
];

async function audit(): Promise<SiteAuditView> {
  const walk = await walkSite(HOME, shopFetcher());
  const findings = siteFindings({
    walk,
    speed: SPEED,
    figures: { missing: "no monthly website visits, monthly orders of your own" },
    measured_at: "2026-10-27T08:00:00.000Z",
  });
  return {
    id: "a1",
    ran_at: "2026-10-27T08:00:00.000Z",
    url: walk.home,
    platform: walk.platform,
    pages: walk.pages.map((p) => ({
      url: p.url,
      role: p.role,
      label: p.label,
      clicks: p.clicks,
      status: p.status,
      error: p.error,
      price_first_screen: p.price_first_screen,
      forms: p.forms,
      mobile: SPEED.find((r) => r.page_url === p.url) ?? null,
      desktop: null,
      speed_error: p.url === BOWL ? "Google couldn't load the page (NO_FCP)" : null,
    })),
    path: walk.path,
    broken: walk.broken,
    refused: walk.refused,
    findings,
    page_reads: walk.reads,
    pagespeed: {
      calls: 2,
      keyed: true,
      note: NO_KEY_NOTE,
      weekly_cap: 50,
      used_this_week: 2,
      next_from: null,
    },
    never: NEVER_LINES,
    not_built: NOT_BUILT,
  };
}

describe("siteWords English is what lib/site said before L-4c, byte for byte", () => {
  it("labels every customer check exactly as specs/customer-checks-v1.json does", () => {
    expect(Object.keys(en.siteWords.check).sort()).toEqual(Object.keys(CHECKS.checks).sort());
    for (const code of Object.keys(CHECKS.checks)) {
      expect(EN(`check.${code}`), code).toBe(checkLabel(code));
      expect(checkWords(code, EN, "en")).toBe(checkLabel(code));
    }
    expect(checkWords("not_a_check", de, "de-DE")).toBe("not_a_check");
  });

  it("says the platform lines, markers and manual steps as before", () => {
    expect(editabilityLine(SHOPIFY)).toBe(
      "Shopify: changes can be applied for you once you give it permission to make changes, a separate step, on its own screen.",
    );
    expect(editabilityLine({ ...SHOPIFY, platform: "wordpress", editable: "partial" })).toBe(
      "WordPress: some elements can be changed programmatically, not all; anything beyond that comes as instructions.",
    );
    expect(editabilityLine(WIX)).toBe(
      "Wix can't be edited programmatically: you'll get the exact change rendered before/after, plus step-by-step instructions for your editor. That's the honest version of this feature for your platform.",
    );
    expect(editabilityLine(detectPlatform("<p>plain</p>"))).toBe(
      "I can't tell what serves this site. I'll show you the change and the diff, and applying it stays manual until I can.",
    );
    expect(detectPlatform("<p>plain</p>").marker).toBe("no platform markers found");
    expect(detectPlatform('<link href="/wp-content/x.css">').marker).toBe(
      "WordPress content paths",
    );
    expect(buildManualInstructions("wix", "Old", "New", "https://a.example/")).toEqual([
      "Open https://a.example/ in your Wix editor.",
      "In the editor, click the text element itself: Wix edits in place.",
      "Find the text: “Old”",
      "Replace it with: “New”",
      "Use the editor's preview to compare against the before/after shown here.",
      "Publish when it matches the after.",
    ]);
    expect(buildManualInstructions("squarespace", "a", "b", "u")[1]).toBe(
      "Edit the page section containing the text (hover → Edit).",
    );
  });

  it("words a change's proposal as before", () => {
    const long = "x".repeat(70);
    const w = siteChangeWords({
      url: "https://shop.example/about",
      find: long,
      replace: "New",
      platform: SHOPIFY,
      baseline_ms: 412,
    });
    expect(w.summary).toBe(`On shop.example: “${"x".repeat(57)}…” → “New”`);
    expect(w.assumption_platform).toBe("The page is served by Shopify (Shopify CDN/theme object)");
    expect(w.assumption_baseline).toBe(
      "Baseline load 412ms at proposal time: the auto-rollback reference",
    );
    expect(w.preview_note).toBe(
      "the page is too large to carry a live preview: the diff above is exact, the render is not shown",
    );
    expect(w.rationale).toBe(
      "Approving queues the change; applying goes through the engine with the page's previous state stored forever, one click from restored.",
    );
    expect(w.base_case).toBe("The page says the new thing; nothing else about it changes.");
    expect(w.downside_case).toBe(
      "The page errors or slows hard after the change. It rolls back automatically and you see why.",
    );
    expect(w.upside_case).toBe(
      "The readback can compare the weeks either side, once measurement is connected.",
    );
    expect(w.breakeven_condition).toBe("no spend: one line of copy");
    expect(w.if_you_change_your_mind).toBe(
      "One click: the page's previous state is stored permanently, not for a window.",
    );
    expect(w.manual_instructions).toBeNull();
    const manual = siteChangeWords({ ...change(), platform: WIX });
    expect(manual.rationale).toBe(
      "Your platform can't be edited programmatically, so approving this gives you the exact rendered change and the steps. Nothing is applied for you.",
    );
    expect(manual.if_you_change_your_mind).toBe(
      "You change it back in your editor: the before render here is the reference.",
    );
  });

  it("refuses in the words it always used", () => {
    const said: [string, Record<string, string | number> | undefined, string][] = [
      ["error.findEmpty", undefined, "say what text to find"],
      ["error.replaceEmpty", undefined, "say what it should become"],
      ["error.nothing", undefined, "that changes nothing"],
      [
        "error.moneyPath",
        { rule: 18 },
        "that page is a money surface: checkout, cart, payment and billing pages are untouchable at any approval level (rule 18)",
      ],
      ["error.pageStatus", { status: "404" }, "the page answered 404: nothing to change there"],
      [
        "error.notFound",
        { find: "Hi" },
        "I can't find “Hi” on that page: copy it exactly as it appears",
      ],
      [
        "error.notUnique",
        { find: "Hi", count: 3 },
        "“Hi” appears 3 times on that page: include enough surrounding text to make it unique",
      ],
      [
        "error.moneyContext",
        { rule: 18 },
        "that text sits inside a checkout or payment area of the page: money surfaces are untouchable, so this cannot even be proposed (rule 18)",
      ],
      ["error.noProposal", undefined, "no such proposal"],
      ["error.notSite", undefined, "not a site proposal"],
      [
        "error.manualApply",
        { platform: "wix" },
        "wix can't be edited programmatically: this change is applied by you, with the instructions on the card",
      ],
      [
        "error.noWriter",
        { platform: "shopify" },
        "applying to shopify needs its write access connected: you will give that permission separately, on its own screen. Until then this card, with its before/after, is the reference for changing it yourself",
      ],
      [
        "error.driftGone",
        undefined,
        "the page changed since you approved: the text isn't there any more; re-propose against today's page",
      ],
      [
        "error.driftNotUnique",
        undefined,
        "the page changed since you approved: the text is no longer unique; re-propose against today's page",
      ],
      ["error.signedIn", undefined, "changing a live site needs you signed in"],
      ["error.proposalId", undefined, "proposal_id is required"],
      ["error.executionId", undefined, "execution_id is required"],
      ["error.fields", undefined, "url, find and replace are required"],
      ["error.auditSignedIn", undefined, "auditing your site needs you signed in"],
    ];
    for (const [key, values, text] of said) {
      expect(siteRefusal(key, values).message, key).toBe(text);
    }
  });

  it("says the audit's stored sentences as before", () => {
    const said: [string, Record<string, string>, string][] = [
      ["fetch.scheme", {}, "only http(s) sites can be read"],
      ["fetch.credentials", {}, "credentials don't belong in a site URL"],
      [
        "fetch.noResolve",
        { host: "x.example" },
        `"x.example" doesn't resolve. Is the address right?`,
      ],
      ["fetch.private", {}, "that address points inside a private network: refusing to fetch it"],
      ["fetch.notAddress", {}, "that doesn't look like a web address"],
      [
        "fetch.ports",
        { http: "80", https: "443" },
        "only http(s) on the standard ports 80 and 443 can be read",
      ],
      ["fetch.redirects", {}, "too many redirects: the site never settled"],
      [
        "audit.noSite",
        {},
        "There's no website in your profile to audit. Add it to your fact sheet.",
      ],
      [
        "audit.cooldown",
        { time: "09:30" },
        "The site was audited less than an hour ago: the next run opens at 09:30 UTC.",
      ],
      ["audit.running", {}, "An audit of this site is already running."],
      ["walk.answers", { status: "404" }, "answers 404"],
      [
        "walk.external",
        { text: "Book", host: "book.example" },
        "Book (on book.example, not opened)",
      ],
      [
        "pagespeed.stopped",
        { reason: "this week's PageSpeed calls for the site are used", made: "2", planned: "6" },
        "this week's PageSpeed calls for the site are used: 2 of 6 measurements made.",
      ],
      [
        "pagespeed.weekUsed",
        { cap: "50" },
        "This week's 50 PageSpeed calls for the site are used, so speed wasn't measured this run.",
      ],
      [
        "pagespeed.short",
        { made: "4", planned: "6" },
        "This week's PageSpeed calls for the site ran short: 4 of 6 measurements made, phones first.",
      ],
      [
        "pagespeed.badKey",
        { status: "403" },
        "Google refused the PageSpeed key (status 403): check that the key allows the PageSpeed Insights API",
      ],
    ];
    for (const [key, values, text] of said) expect(EN(key, values), key).toBe(text);
    expect(NO_KEY_NOTE).toBe(
      "Page speed wasn't measured: Google's PageSpeed service needs a free API key (PAGESPEED_API_KEY) and refuses every request without one. The path to buying and the broken links were still read.",
    );
  });

  it("words the walk and the findings as before", async () => {
    const view = await audit();
    expect(view.path.steps.map((s) => s.label)).toEqual([
      "Home",
      "Shop all",
      "Blue bowl",
      "Add to cart (button seen, not pressed)",
      "Checkout (entry seen, not opened)",
    ]);
    expect(view.path.notes[0]).toBe(
      "Counted by following the site's own links from the home page; nothing was added to a cart and checkout was never opened.",
    );
    const by = (code: string) => view.findings.find((f) => f.code === code);
    expect(by("lcp_slow")?.title.en).toBe(
      "The main content takes 5.2 s to appear on a phone: audit-shop.example",
    );
    expect(by("lcp_slow")?.detail.en).toBe(
      "Largest Contentful Paint: how long until the biggest thing on the screen shows. Measured from one test load on Google's emulated device (lab data). 1 other page is also outside the good line.",
    );
    expect(by("lcp_slow")?.threshold).toBe("good ≤ 2.5 s, poor > 4.0 s (Google)");
    expect(by("page_heavy")?.title.en).toBe("The page weighs 4.5 MB: audit-shop.example");
    expect(by("page_heavy")?.threshold).toBe("heavy > 3.0 MB, very heavy > 6.0 MB (ScaleX)");
    expect(by("tap_targets")?.title.en).toBe(
      "3 buttons or links are too small or too close to tap: audit-shop.example",
    );
    expect(by("tap_targets")?.threshold).toBe("any is a finding; 5 or more is medium (ScaleX)");
    expect(by("form_long")?.title.en).toBe(
      "The contact form asks for 9 things: audit-shop.example/pages/contact",
    );
    expect(by("form_long")?.detail.en).toBe(
      "2 of them required. Counted from the page's HTML; the form was not sent.",
    );
    expect(by("form_long")?.threshold).toBe(
      "6 or more fields is long, 9 or more very long (ScaleX)",
    );
    expect(by("price_hidden")?.title.en).toBe(
      "No price on the first screen of “Blue bowl”: audit-shop.example/products/blue-bowl",
    );
    expect(by("price_hidden")?.threshold).toBe(
      "a price within the first screen of a product or service page (ScaleX heuristic: the first 600 characters of the page's own text)",
    );
    expect(by("broken_link")?.title.en).toMatch(
      /^A link on audit-shop\.example(\/[a-z/-]*)? is broken: audit-shop\.example\/collections\/sale answers 404$/,
    );
    expect(by("broken_link")?.threshold).toBe(
      "any link on your own site answering 400 or above, or not loading (ScaleX)",
    );
    expect(by("lcp_slow")?.euro).toEqual({
      computed: false,
      why: "not computed: it needs your own site traffic and conversion (no monthly website visits, monthly orders of your own)",
    });
  });

  it("works the € line out in the same words", () => {
    const figures: OwnerSiteFigures = {
      sessions_per_month: 4000,
      orders_per_month: 80,
      aov_minor: 4500,
      currency: "EUR",
      basis: "measured",
      window: "your connectors' last month, as of 26 Oct 2026",
      as_of: "2026-10-26",
      sources: [],
    };
    const euro = speedEuro(4500, figures);
    if (!euro.computed) throw new Error("expected a € line");
    expect(euro.formula).toBe(
      "4,000 visits × 2.0% conversion × €45.00 order value × 1–4% per second × 2.0 s over the good line",
    );
    expect(euro.assumed).toEqual([
      "ASSUMED: each second a phone waits past 2.5 s loses 1–4% of orders, a rule of thumb from published retail studies, not measured on your site.",
      "ASSUMED: every order counted passes through this page's load; the share that comes on a phone isn't measured, so the high end overstates.",
      "ASSUMED: at most 3 seconds are counted.",
    ]);
    const de2 = localizeEuro(euro, de, "de-DE");
    if (!de2.computed) throw new Error("expected a € line");
    // Intl's own no-break spaces, as plain ones for reading.
    expect(de2.formula.replace(/[\u00a0\u202f]/g, " ")).toBe(
      "4.000 Besuche × 2,0 % Konversion × 45,00 € Bestellwert × 1–4 % pro Sekunde × 2,0 s über dem guten Bereich",
    );
    expect(de2.window).toBe("der letzte Monat Ihrer Datenquellen, Stand 26. Okt. 2026");
    expect(de2.assumed[2]).toBe("ANGENOMMEN: Gezählt werden höchstens 3 Sekunden.");
    // English is never touched.
    expect(localizeEuro(euro, EN, "en")).toBe(euro);
  });
});

function change() {
  return {
    url: "https://shop.example/",
    find: "Old words",
    replace: "New words",
    platform: SHOPIFY,
    baseline_ms: 412,
  };
}

function proposalRow(platform: PlatformVerdict = SHOPIFY) {
  const words = siteChangeWords({ ...change(), platform });
  return {
    id: "p1",
    status: "pending",
    action: {
      kind: "operations_change",
      summary: words.summary,
      detail: {
        url: "https://shop.example/",
        find: "Old words",
        replace: "New words",
        platform,
        platform_line: words.platform_line,
        site_preview: null,
        preview_note: words.preview_note,
        manual_instructions: words.manual_instructions,
        health_baseline_ms: 412,
        manual_limits: [],
        rationale: words.rationale,
      },
    },
    scenario: {
      assumptions: [
        { statement: words.assumption_platform, sensitivity: "medium" },
        { statement: words.assumption_baseline, sensitivity: "low" },
      ],
      base_case: { statement: words.base_case },
      downside_case: { statement: words.downside_case },
      upside_case: { statement: words.upside_case },
      breakeven_condition: words.breakeven_condition,
    },
    reversibility: { level: "easy", if_you_change_your_mind: words.if_you_change_your_mind },
  };
}

describe("the website screen in German", () => {
  it("says a stored proposal again from its structure, and leaves the row alone", () => {
    const row = proposalRow(WIX);
    const before = JSON.stringify(row);
    const out = localizeSiteProposal(row, de, "de-DE") as unknown as ReturnType<
      typeof proposalRow
    > & { action: { detail: { platform_word: string; editable_word: string } } };
    expect(JSON.stringify(row)).toBe(before);
    expect(out.action.summary).toBe("Auf shop.example: „Old words“ → „New words“");
    expect(out.action.detail.platform_line).toMatch(
      /^Wix lässt sich nicht programmgesteuert bearbeiten/,
    );
    expect(out.action.detail.manual_instructions?.[0]).toBe(
      "Öffnen Sie https://shop.example/ in Ihrem Wix-Editor.",
    );
    expect(out.action.detail.editable_word).toBe("von Hand");
    expect(out.scenario.assumptions[0]?.statement).toBe(
      "Die Seite wird von Wix ausgeliefert (statische Wix-Dateien)",
    );
    expect(out.scenario.assumptions[1]?.statement).toBe(
      "Ladezeit beim Vorschlag: 412 ms; der Bezugswert für das automatische Zurücksetzen",
    );
    expect(out.reversibility.if_you_change_your_mind).toBe(
      "Sie ändern es in Ihrem Editor zurück: die Vorher-Darstellung hier ist die Vorlage.",
    );
    // The page's own text stays as the owner gave it.
    expect(out.action.detail.find).toBe("Old words");
  });

  it("keeps a sentence ScaleX no longer says as it was stored", () => {
    const row = proposalRow();
    row.action.summary = "An older summary";
    row.reversibility.if_you_change_your_mind = "An older reversal";
    const out = localizeSiteProposal(row, de, "de-DE") as unknown as ReturnType<typeof proposalRow>;
    expect(out.action.summary).toBe("An older summary");
    expect(out.reversibility.if_you_change_your_mind).toBe("An older reversal");
    expect(out.scenario.base_case.statement).toBe(
      "Die Seite sagt das Neue; sonst ändert sich nichts an ihr.",
    );
    // English readers get the row as stored, with the words the header shows.
    const english = localizeSiteProposal(proposalRow(), EN, "en") as unknown as {
      action: { summary: string; detail: { platform_word: string; editable_word: string } };
    };
    expect(english.action.summary).toBe(proposalRow().action.summary);
    expect(english.action.detail.platform_word).toBe("Shopify");
    expect(english.action.detail.editable_word).toBe("api");
  });

  it("says the checks, the refusals and the stored reasons in German", () => {
    expect(checkWords("opening_hours", de, "de-DE")).toBe("Öffnungszeiten");
    expect(
      siteErrorWords(siteRefusal("error.notUnique", { find: "Hi", count: 3 }), de, "de-DE"),
    ).toBe(
      "„Hi“ kommt auf dieser Seite 3 Mal vor: nehmen Sie genug umgebenden Text dazu, damit es eindeutig wird",
    );
    expect(siteErrorWords(new Error("from elsewhere"), de, "de-DE")).toBe("from elsewhere");
    expect(
      localizeFailure(
        { at: "2026-10-27", reason: "Your home page couldn't be read: the home page answered 503" },
        de,
        "de-DE",
      )?.reason,
    ).toBe("Ihre Startseite konnte nicht gelesen werden: die Startseite hat mit 503 geantwortet");
    expect(sayStored("fetch failed", de, "de-DE")).toBe("fetch failed");
    expect(
      sayStored(
        "not computed: it needs your own site traffic and conversion (no monthly website visits, monthly orders of your own)",
        de,
        "de-DE",
      ),
    ).toBe(
      "nicht berechnet: dafür braucht es den eigenen Traffic und die Konversion Ihrer Website (es fehlen eigene Angaben: monatliche Website-Besuche und monatliche Bestellungen)",
    );
    expect(parseStored("answers 404")).toEqual({ key: "walk.answers", values: { status: "404" } });
  });

  it("words a stored audit's findings, path and notes in German", async () => {
    const view = await audit();
    const out = localizeSiteAudit(view, de, "de-DE");
    const by = (code: string) => out.findings.find((f) => f.code === code);
    expect(by("lcp_slow")?.title.en).toBe(
      "Der Hauptinhalt braucht auf dem Telefon 5,2 s, bis er erscheint: audit-shop.example",
    );
    expect(by("lcp_slow")?.threshold).toBe("gut ≤ 2,5 s, schlecht > 4,0 s (Google)");
    expect(by("lcp_slow")?.detail.en).toMatch(/1 weitere Seite liegt ebenfalls außerhalb/);
    expect(by("page_heavy")?.title.en).toBe("Die Seite wiegt 4,5 MB: audit-shop.example");
    expect(by("broken_link")?.title.en).toMatch(/collections\/sale antwortet mit 404$/);
    expect(by("form_long")?.title.en).toBe(
      "Das Kontaktformular fragt 9 Angaben ab: audit-shop.example/pages/contact",
    );
    expect(out.path.steps[0]?.label).toBe("Startseite");
    expect(out.path.steps[1]?.label).toBe("Shop all"); // the site's own link text
    expect(out.path.notes[0]).toMatch(/^Gezählt, indem den eigenen Links/);
    expect(out.pagespeed.note).toMatch(/^Die Ladegeschwindigkeit wurde nicht gemessen/);
    expect(out.pages.find((p) => p.url === BOWL)?.speed_error).toBe(
      "Google konnte die Seite nicht laden (NO_FCP)",
    );
    // Every finding was said again; the stored view is untouched.
    for (const f of out.findings) {
      const stored = view.findings.find((s) => s.id === f.id);
      expect(f.title.en, f.id).not.toBe(stored?.title.en);
    }
    expect(view.findings.find((f) => f.code === "lcp_slow")?.title.en).toMatch(/^The main/);
    expect(localizeSiteAudit(view, EN, "en")).toBe(view);
  });
});

describe("Russian counts and Chinese joins", () => {
  it("gives Russian its forms at 1, 3, 5 and 21", () => {
    const others = (count: number) => ru("finding.detail.others", { count });
    expect(others(1)).toBe("Ещё 1 страница тоже вне хорошего диапазона.");
    expect(others(3)).toBe("Ещё 3 страницы тоже вне хорошего диапазона.");
    expect(others(5)).toBe("Ещё 5 страниц тоже вне хорошего диапазона.");
    expect(others(21)).toBe("Ещё 21 страница тоже вне хорошего диапазона.");
    const clicks = (count: number) => ru("finding.title.pathLong", { count, entry: "checkout" });
    expect(clicks(1)).toMatch(/— 1 клик$/);
    expect(clicks(3)).toMatch(/— 3 клика$/);
    expect(clicks(5)).toMatch(/— 5 кликов$/);
    expect(clicks(21)).toMatch(/— 21 клик$/);
  });

  it("joins Chinese sentences with no space after full-width punctuation", async () => {
    expect(joinSentences(["第一句。", "第二句。"], zh)).toBe("第一句。第二句。");
    expect(joinSentences(["One.", "Two."], EN)).toBe("One. Two.");
    const out = localizeSiteAudit(await audit(), zh, "zh-Hans");
    const lcp = out.findings.find((f) => f.code === "lcp_slow");
    expect(lcp?.detail.en).toContain("。另有 1 个页面也在良好范围之外。");
    expect(lcp?.detail.en).not.toMatch(/。 /);
    expect(lcp?.title.en).toBe("主要内容在手机上需要 5.2 秒才出现：audit-shop.example");
  });
});
