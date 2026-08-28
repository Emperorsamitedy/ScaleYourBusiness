// The live seam, proven without the network where possible — and with a
// local server where the claim IS about the network (the timeout).

import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { CAPS } from "./competitor";
import {
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

  it("returns stripped text and the page title", async () => {
    const url = await serve((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<title>Bolt</title><p>Szállítás 2 nap</p>");
    });
    const page = await livePageFetcher(url, 2_000);
    expect(page?.title).toBe("Bolt");
    expect(page?.text).toContain("Szállítás 2 nap");
  });

  it("gives up at the timeout instead of waiting — rule 2 on the wire", async () => {
    const url = await serve(() => {
      /* never responds */
    });
    const t0 = Date.now();
    const page = await livePageFetcher(url, 300);
    expect(page).toBeNull();
    // Must return promptly after the deadline, far inside the 8s cap.
    expect(Date.now() - t0).toBeLessThan(CAPS.page_timeout_ms);
  });

  it("refuses non-HTML and error statuses", async () => {
    const pdf = await serve((_req, res) => {
      res.setHeader("content-type", "application/pdf");
      res.end("%PDF-1.4");
    });
    expect(await livePageFetcher(pdf, 2_000)).toBeNull();

    const broken = await serve((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    expect(await livePageFetcher(broken, 2_000)).toBeNull();
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
