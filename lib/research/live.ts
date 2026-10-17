// The live outside world — the real implementations of Session C's
// injectable seams. Everything in competitor.ts and discovery.ts is
// provable offline; this file is the only place that actually touches
// the network, and it obeys the same four rules.
//
// Search rides Anthropic's server-side web_search tool on Haiku rather
// than a separate search API: it uses the key the project already funds,
// it is metered and logged like every other call, and it needs no new
// account anywhere. The search RESULTS are parsed deterministically from
// the tool-result blocks — the model's prose is never the data path.

import type { PageFetcher as GuardedFetch } from "../site/fetch";
import { livePageFetcher as guardedFetch } from "../site/fetch";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../llm/client";
import { buildCallRecord, logLlmCall } from "../llm/cost-log";
import type { FetchedPage, SearchHit, SearchProvider, PageFetcher } from "./competitor";
import { RESEARCH_MODEL, ResearchError } from "./competitor";

/* ── deterministic pieces, exported for tests ── */

/** Visible text from an HTML document. No DOM, no dependency — enough
 * for price lists and delivery pages, which is all we read. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(?:p|div|li|tr|br|h[1-6]|section|article|table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtml(m[1]!).slice(0, 200) : "";
}

/** Search hits out of a response's content blocks — a deterministic
 * parse of the tool results, never a parse of model prose. */
export function parseSearchResults(content: readonly Anthropic.ContentBlock[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue; // an error block, not results
    for (const item of block.content) {
      if (item.type !== "web_search_result") continue;
      // The API returns titles and URLs; result text is encrypted for
      // citation use only, so the honest snippet is an empty one.
      hits.push({ url: item.url, title: item.title, snippet: "" });
    }
  }
  return hits;
}

/* ── live search (rule 2: one search per call, capped by the API) ── */

export const liveSearchProvider: SearchProvider = async (query, limit) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 300,
    system:
      "Run exactly one web search for the user's query, then reply with the single word: done. Do not summarise the results.",
    messages: [{ role: "user", content: query }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  });
  logLlmCall(
    buildCallRecord({
      workload: "research",
      account_id: "search",
      model: RESEARCH_MODEL,
      duration_ms: Date.now() - started,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }),
  );
  return parseSearchResults(response.content).slice(0, limit);
};

/* ── live page fetch (rule 1: GET only; rule 2: timeout + size cap) ── */

/** Bytes of raw HTML considered, before stripping. A page bigger than
 * this is a web app, not a shop window. */
export const MAX_FETCH_CHARS = 300_000;

/**
 * Research reads the public web through the SAME guarded fetcher the site
 * audit uses (lib/site/fetch): every hop resolved once, its addresses
 * vetted against private, loopback and link-local ranges, the connection
 * pinned to them, redirects re-vetted, bytes capped. Before the security
 * review of 2026-10-17 this was a bare fetch that followed redirects
 * anywhere — a page ranked for a competitor's name could bounce the
 * server to localhost or a metadata address and read the answer back.
 */
export function createLivePageFetcher(fetchGuarded: GuardedFetch = guardedFetch): PageFetcher {
  return async (url, timeoutMs) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const page = await Promise.race([
        fetchGuarded(url),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (!page || page.status < 200 || page.status >= 300) return null;
      const type = page.headers["content-type"] ?? "";
      if (!/text\/html|application\/xhtml|text\/plain/.test(type)) return null;
      const raw = page.html.slice(0, MAX_FETCH_CHARS);
      const text = stripHtml(raw);
      if (text === "") return null;
      return { url: page.url, title: extractTitle(raw), text } satisfies FetchedPage;
    } catch {
      // Refused address, timeout, DNS failure, TLS error — a page that cannot
      // be read is a page skipped, never a run killed (competitor.ts decides
      // when nothing at all loaded).
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export const livePageFetcher: PageFetcher = createLivePageFetcher();

/** Guard for routes: research must never be pointed at localhost or a
 * private range — it reads the public web only. */
export function isPublicHttpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(?:127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host))
    return false;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === "0.0.0.0" || host === "[::1]" || host === "::1") return false;
  return true;
}

export { ResearchError };
