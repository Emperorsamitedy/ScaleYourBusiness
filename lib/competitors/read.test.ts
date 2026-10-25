// Feature 35 — reading listed pages: robots.txt honoured, logins refused,
// the page cap, and the SSRF refusals of the hardened helper. Every fetch
// is faked or refused before any connection; the global fetch fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FetchedPage, PageFetcher } from "../site/fetch";
import { SiteFetchError } from "../site/fetch";
import {
  CAP_REASON,
  COMPETITOR_USER_AGENT,
  LOGIN_REASON,
  READ_CAPS,
  competitorFetcher,
  normalizePageUrl,
  readListedPages,
} from "./read";

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const PRICELIST = readFileSync(join(__dirname, "fixtures", "salon-pricelist.html"), "utf8");
const now = () => new Date("2026-10-19T07:00:00Z");

/** A fake web: url → page; records every request. */
function fakeWeb(pages: Record<string, Partial<FetchedPage> & { html?: string }>) {
  const asked: string[] = [];
  const fetcher: PageFetcher = (url) => {
    asked.push(url);
    const p = pages[url];
    if (!p) return Promise.resolve({ url, status: 404, html: "", headers: {}, duration_ms: 1 });
    return Promise.resolve({
      url: p.url ?? url,
      status: p.status ?? 200,
      html: p.html ?? "",
      headers: p.headers ?? { "content-type": "text/html; charset=utf-8" },
      duration_ms: 1,
    });
  };
  return { fetcher, asked };
}

describe("robots.txt is honoured", () => {
  it("doesn't fetch a page its robots.txt disallows", async () => {
    const web = fakeWeb({
      "https://nova.example/robots.txt": {
        html: "User-agent: *\nDisallow: /prices\n",
        headers: { "content-type": "text/plain" },
      },
      "https://nova.example/prices": { html: PRICELIST },
      "https://nova.example/": { html: PRICELIST },
    });
    const out = await readListedPages({
      urls: ["https://nova.example/prices", "https://nova.example/"],
      fetcher: web.fetcher,
      now,
    });
    expect(out.map((o) => [o.outcome, o.reason])).toEqual([
      ["refused", "their robots.txt asks robots not to read this page"],
      ["read", null],
    ]);
    // robots.txt once per origin; the disallowed page never requested.
    expect(web.asked).toEqual(["https://nova.example/robots.txt", "https://nova.example/"]);
  });

  it("reads nothing when robots.txt can't be reached", async () => {
    const out = await readListedPages({
      urls: ["https://down.example/prices"],
      fetcher: (url) =>
        url.endsWith("/robots.txt")
          ? Promise.reject(new Error("socket hang up"))
          : Promise.reject(new Error("must not be fetched")),
      now,
    });
    expect(out[0]?.reason).toBe("their robots.txt couldn't be read, so I didn't read the page");
  });

  it("checks the robots.txt of a site a page redirects to", async () => {
    const web = fakeWeb({
      "https://nova.example/prices": { url: "https://book.example/nova", html: PRICELIST },
      "https://book.example/robots.txt": { html: "User-agent: *\nDisallow: /\n" },
    });
    const out = await readListedPages({
      urls: ["https://nova.example/prices"],
      fetcher: web.fetcher,
      now,
    });
    expect(out[0]?.outcome).toBe("refused");
    expect(out[0]?.extract).toBeNull();
  });
});

describe("finding 20 (review 2026-10-23): robots.txt judges the page a redirect lands on", () => {
  const robots = {
    html: "User-agent: *\nDisallow: /members\n",
    headers: { "content-type": "text/plain" },
  };

  it("refuses a same-origin redirect into a disallowed path", async () => {
    const web = fakeWeb({
      "https://nova.example/robots.txt": robots,
      "https://nova.example/prices": {
        url: "https://nova.example/members/prices",
        html: PRICELIST,
      },
    });
    const out = await readListedPages({
      urls: ["https://nova.example/prices"],
      fetcher: web.fetcher,
      now,
    });
    expect(out[0]?.outcome).toBe("refused");
    expect(out[0]?.reason).toBe("it redirects to a page their robots.txt asks robots not to read");
    expect(out[0]?.extract).toBeNull();
  });

  it("still reads a same-origin redirect into an allowed path", async () => {
    const web = fakeWeb({
      "https://nova.example/robots.txt": robots,
      "https://nova.example/prices": { url: "https://nova.example/price-list", html: PRICELIST },
    });
    const out = await readListedPages({
      urls: ["https://nova.example/prices"],
      fetcher: web.fetcher,
      now,
    });
    expect(out[0]?.outcome).toBe("read");
  });
});

describe("never behind a login", () => {
  it("refuses a sign-in or account address before fetching it", async () => {
    const web = fakeWeb({});
    const out = await readListedPages({
      urls: ["https://nova.example/my-account/bookings", "https://nova.example/login?next=/"],
      fetcher: web.fetcher,
      now,
    });
    expect(out.map((o) => o.reason)).toEqual([LOGIN_REASON, LOGIN_REASON]);
    expect(web.asked).toEqual([]);
  });

  it("refuses a page that turns out to be a login form, or answers 401", async () => {
    const web = fakeWeb({
      "https://nova.example/prices": { html: '<form><input type="password" name="pw"></form>' },
      "https://nova.example/members": { status: 401 },
    });
    const out = await readListedPages({
      urls: ["https://nova.example/prices", "https://nova.example/members"],
      fetcher: web.fetcher,
      now,
    });
    expect(out.map((o) => [o.outcome, o.reason])).toEqual([
      ["refused", LOGIN_REASON],
      ["refused", LOGIN_REASON],
    ]);
  });
});

describe("the page cap", () => {
  it("reads at most five pages per competitor and says so for the rest", async () => {
    const urls = Array.from(
      { length: READ_CAPS.max_pages_per_competitor + 2 },
      (_, i) => `https://nova.example/p${i}`,
    );
    const web = fakeWeb(Object.fromEntries(urls.map((u) => [u, { html: PRICELIST }])));
    const out = await readListedPages({ urls, fetcher: web.fetcher, now });
    expect(out.filter((o) => o.outcome === "read")).toHaveLength(
      READ_CAPS.max_pages_per_competitor,
    );
    expect(out.filter((o) => o.reason === CAP_REASON)).toHaveLength(2);
  });

  it("reads each page once, and refuses what isn't a web address", async () => {
    expect(normalizePageUrl("nova.example/prices#hair")).toBe("https://nova.example/prices");
    expect(normalizePageUrl("ftp://nova.example/")).toBeNull();
    expect(normalizePageUrl("https://me:pw@nova.example/")).toBeNull();
    const web = fakeWeb({ "https://nova.example/": { html: PRICELIST } });
    const out = await readListedPages({
      urls: ["nova.example", "https://nova.example/", "javascript:alert(1)"],
      fetcher: web.fetcher,
      now,
    });
    expect(out.map((o) => o.outcome)).toEqual(["read", "refused"]);
  });
});

describe("SSRF: every request goes through the hardened helper", () => {
  it("identifies itself plainly", () => {
    expect(COMPETITOR_USER_AGENT).toMatch(/^SYB-CompetitorRead\/1\.0 \(/);
  });

  it.each([
    "http://127.0.0.1/prices",
    "http://10.0.0.8/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
  ])("refuses %s before connecting", async (url) => {
    await expect(competitorFetcher(url)).rejects.toThrow(SiteFetchError);
    await expect(competitorFetcher(url)).rejects.toThrow(/private network/);
  });

  it.each(["http://localhost:5433/", "https://nova.example:8080/", "http://[::127.0.0.1]:6379/"])(
    "refuses %s for its port before resolving anything (finding 20)",
    async (url) => {
      await expect(competitorFetcher(url)).rejects.toThrow(/ports 80 and 443/);
      const out = await readListedPages({ urls: [url], fetcher: competitorFetcher, now });
      expect(out[0]).toMatchObject({ outcome: "refused", extract: null });
    },
  );

  it("refuses credentials and non-web schemes", async () => {
    await expect(competitorFetcher("https://user:pw@nova.example/")).rejects.toThrow(/credentials/);
    await expect(competitorFetcher("file:///etc/passwd")).rejects.toThrow(/only http/);
  });

  it("records a private address as refused, reading nothing on it", async () => {
    const out = await readListedPages({
      urls: ["http://169.254.169.254/latest/meta-data/"],
      fetcher: competitorFetcher,
      now,
    });
    expect(out[0]).toMatchObject({ outcome: "refused", extract: null });
    expect(out[0]?.reason).toMatch(/private network/);
  });
});
