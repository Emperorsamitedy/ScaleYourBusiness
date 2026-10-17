// The live seam, proven without the network where possible — and with a
// local server where the claim IS about the network (the timeout).

import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { CAPS } from "./competitor";
import type { FetchedPage as SiteFetchedPage, PageFetcher as GuardedFetch } from "../site/fetch";
import {
  createLivePageFetcher,
  extractTitle,
  isPublicHttpUrl,
  livePageFetcher,
  MAX_FETCH_CHARS,
  parseSearchResults,
  stripHtml,
} from "./live";

/* ── stripHtml: the page reader is deterministic code ── */

describe("stripHtml", () => {
  it("keeps visible text, drops script/style/comments", () => {
    const html = `<html><head><style>.x{color:red}</style>
      <script>alert("no")</script></head>
      <body><!-- hidden --><h1>Szörp</h1><p>0,5 l &mdash; 6 490 Ft</p>
      <div>Szállítás: 2&nbsp;nap</div></body></html>`;
    const text = stripHtml(html);
    expect(text).toContain("Szörp");
    expect(text).toContain("6 490 Ft");
    expect(text).toContain("Szállítás: 2 nap");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("hidden");
  });

  it("decodes the entities that appear on price pages", () => {
    expect(stripHtml("K&amp;M &quot;Bolt&quot; &lt;hivatalos&gt; &#39;ár&#39;")).toBe(
      `K&M "Bolt" <hivatalos> 'ár'`,
    );
  });

  it("turns block boundaries into line breaks so prices stay separable", () => {
    const text = stripHtml("<li>0,5L — 6 490 Ft</li><li>1L — 9 990 Ft</li>");
    expect(text.split("\n").map((l) => l.trim())).toEqual(
      expect.arrayContaining(["0,5L — 6 490 Ft", "1L — 9 990 Ft"]),
    );
  });
});

describe("extractTitle", () => {
  it("reads the title tag and strips its markup", () => {
    expect(extractTitle("<title>Szomszéd &amp; Társa</title>")).toBe("Szomszéd & Társa");
    expect(extractTitle("<p>no title</p>")).toBe("");
  });
});

/* ── search result parsing: tool-result blocks, never model prose ── */

describe("parseSearchResults", () => {
  const resultBlock = (urls: string[]): Anthropic.ContentBlock =>
    ({
      type: "web_search_tool_result",
      tool_use_id: "t1",
      content: urls.map((url) => ({
        type: "web_search_result",
        url,
        title: `Title of ${url}`,
        encrypted_content: "x",
        page_age: null,
      })),
    }) as unknown as Anthropic.ContentBlock;

  it("collects hits from tool-result blocks and ignores prose", () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "text", text: "https://not-a-result.example — ignore me", citations: null } as never,
      resultBlock(["https://a.hu", "https://b.hu"]),
    ];
    const hits = parseSearchResults(content);
    expect(hits.map((h) => h.url)).toEqual(["https://a.hu", "https://b.hu"]);
    expect(hits[0]!.title).toBe("Title of https://a.hu");
  });

  it("treats an error block as zero results, not a crash", () => {
    const errorBlock = {
      type: "web_search_tool_result",
      tool_use_id: "t1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" },
    } as unknown as Anthropic.ContentBlock;
    expect(parseSearchResults([errorBlock])).toEqual([]);
  });
});

/* ── the fetcher: timeout honoured, junk refused ── */

describe("livePageFetcher", () => {
  const servers: http.Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      });
    });
  }

  /** A stand-in for the guarded site fetcher, answering what the test says. */
  const page =
    (over: Partial<SiteFetchedPage> = {}): GuardedFetch =>
    async (url) => ({
      url,
      status: 200,
      html: "<title>Bolt</title><p>Szállítás 2 nap</p>",
      headers: { "content-type": "text/html; charset=utf-8" },
      duration_ms: 5,
      ...over,
    });

  it("returns stripped text and the page title", async () => {
    const got = await createLivePageFetcher(page())("https://bolt.example/", 2_000);
    expect(got?.title).toBe("Bolt");
    expect(got?.text).toContain("Szállítás 2 nap");
  });

  it("THE ATTACK (SSRF): a real page on a loopback address is refused, not read", async () => {
    // The 2026-10-17 security review: research used to read whatever a
    // search result (or its redirect) pointed at, localhost included.
    const url = await serve((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<title>internal</title><p>secret admin page</p>");
    });
    expect(await livePageFetcher(url, 2_000)).toBeNull();
  });

  it("gives up at the timeout instead of waiting — rule 2 on the wire", async () => {
    const never: GuardedFetch = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await createLivePageFetcher(never)("https://slow.example/", 300)).toBeNull();
    // Must return promptly after the deadline, far inside the 8s cap.
    expect(Date.now() - t0).toBeLessThan(CAPS.page_timeout_ms);
  });

  it("refuses non-HTML, error statuses and a refused fetch", async () => {
    const fetchPage = (g: GuardedFetch) => createLivePageFetcher(g)("https://x.example/", 2_000);
    expect(await fetchPage(page({ headers: { "content-type": "application/pdf" } }))).toBeNull();
    expect(await fetchPage(page({ status: 500 }))).toBeNull();
    expect(
      await fetchPage(async () => {
        throw new Error("that address is private");
      }),
    ).toBeNull();
  });

  it("caps how much raw HTML it will even consider", () => {
    expect(MAX_FETCH_CHARS).toBeLessThanOrEqual(500_000);
  });
});

/* ── the public-web guard on the route boundary ── */

describe("isPublicHttpUrl", () => {
  it("accepts the public web and nothing else", () => {
    expect(isPublicHttpUrl("https://szomszed-szorp.hu/arak")).toBe(true);
    expect(isPublicHttpUrl("http://example.com")).toBe(true);
    for (const bad of [
      "ftp://example.com",
      "javascript:alert(1)",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.1.1/",
      "http://db.internal/",
      "not a url",
    ]) {
      expect(isPublicHttpUrl(bad), bad).toBe(false);
    }
  });
});
