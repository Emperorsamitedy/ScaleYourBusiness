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
import { createGuardedFetcher } from "../site/fetch";
import type Anthropic from "@anthropic-ai/sdk";
import { readListedPages } from "../competitors/read";
import { readAnswer } from "../llm/answer";
import { anthropicClient } from "../llm/client";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import type { FetchedPage, SearchHit, SearchProvider, PageFetcher } from "./competitor";
import { CAPS, RESEARCH_MODEL, RESEARCH_WORKLOADS, ResearchError, declined } from "./competitor";
import { extractTitle, stripHtml } from "../site/html-text";

export { extractTitle, stripHtml };

/* ── deterministic pieces, exported for tests ── */

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

export const liveSearchProvider: SearchProvider = async (query, limit, accountId) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: RESEARCH_MODEL,
    // Room for adaptive thinking before the one search call and "done".
    max_tokens: 1_000,
    // One search for a given name, no judgement: the lowest effort.
    output_config: { effort: "low" },
    system:
      "Run exactly one web search for the user's query, then reply with the single word: done. Do not summarise the results.",
    messages: [{ role: "user", content: query }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  });
  // Persisted with the real account id: the daily cap counts these rows
  // (review 2026-10-23, finding 9 — this used to log account "search" to
  // the console only, with the search fee uncosted).
  const record = buildCallRecord({
    workload: RESEARCH_WORKLOADS.search,
    account_id: accountId,
    model: RESEARCH_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    web_search_requests: response.usage.server_tool_use?.web_search_requests ?? 0,
  });
  await recordLlmCall(record);
  // A refusal throws before any block is read: a declined search has no results.
  const { refusal } = readAnswer(response, record);
  if (refusal !== null) throw new ResearchError(declined(refusal));
  // The hits are read by block type, so leading thinking blocks are skipped.
  return parseSearchResults(response.content).slice(0, limit);
};

/* ── live page fetch (rule 1: GET only; rule 2: timeout + size cap) ── */

/** Bytes of raw HTML considered, before stripping. A page bigger than
 * this is a web app, not a shop window. */
export const MAX_FETCH_CHARS = 300_000;

/**
 * Honest about who we are and why: these are pages a search found for a
 * business the owner named, read once on their request. robots.txt groups
 * match on "SYB", as for the weekly reader.
 */
export const RESEARCH_USER_AGENT =
  "SYB-CompetitorResearch/1.0 (reads a few public pages about a business a customer asked about, on request; honours robots.txt)";

/** The hardened site fetcher with research's own agent, timeout and byte cap. */
const researchGuardedFetch: GuardedFetch = createGuardedFetcher({
  userAgent: RESEARCH_USER_AGENT,
  timeoutMs: CAPS.page_timeout_ms,
  maxBytes: MAX_FETCH_CHARS,
});

/**
 * Research reads the public web through the competitor reader's own path
 * (lib/competitors/read: readListedPages): robots.txt read and obeyed for
 * the page and wherever it redirects, sign-in and account pages refused,
 * and every request through the hardened fetcher (each hop resolved once,
 * vetted against private ranges, pinned, ports 80/443 only, bytes capped).
 * Before the review of 2026-10-23 (finding 9) research never read
 * robots.txt; before the 2026-10-17 review it was a bare fetch that
 * followed redirects anywhere.
 */
export function createLivePageFetcher(
  fetchGuarded: GuardedFetch = researchGuardedFetch,
): PageFetcher {
  return async (url, timeoutMs) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = readListedPages({
        urls: [url],
        fetcher: fetchGuarded,
        now: () => new Date(),
      }).then(([outcome]) => outcome ?? null);
      const outcome = await Promise.race([
        read,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (!outcome || outcome.outcome !== "read" || !outcome.extract) return null;
      const text = outcome.extract.text.trim();
      if (text === "") return null;
      return { url: outcome.url, title: outcome.title ?? "", text } satisfies FetchedPage;
    } catch {
      // readListedPages never throws; this is belt and braces. A page that
      // cannot be read is a page skipped, never a run killed.
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
