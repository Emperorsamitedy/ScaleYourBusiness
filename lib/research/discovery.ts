// Competitor discovery — the half of "competitor research" the plan
// actually meant: the agent goes and looks. From the owner's own facts
// (what the business does, what it sells, where it is) to 3–5 real
// candidate competitors with URLs, for the OWNER to confirm — discovery
// proposes, it never writes a Competitor record on its own. Confirming a
// candidate is what triggers researchCompetitor on it.
//
// Session C's four rules apply unchanged. The searching happens inside
// one capped LLM call (Haiku + web_search, max three searches); every
// deterministic decision after it — parsing, dropping the unusable,
// deduplication, the cap — is code, not inference, and is tested as code.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { competitors } from "../../db/schema";
import type { Field } from "../core/field";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { readCurrentField } from "../profile/field-store";
import type { ProgressEvent, ProgressSink } from "./competitor";
import { CAPS, RESEARCH_MODEL, ResearchError } from "./competitor";
import { isPublicHttpUrl } from "./live";

export const DISCOVERY_CAPS = {
  /** Candidates returned to the owner. The plan says 3–5; five is the ceiling. */
  max_candidates: 5,
  /** Web searches the one model call may run. */
  max_searches: 3,
} as const;

/** Hosts that are never a competitor's own presence — search engines,
 * encyclopedias, review aggregators. A marketplace shopfront (etsy,
 * facebook) IS allowed: for many small businesses it is the shop. */
const NEVER_A_COMPETITOR = [
  "google.",
  "bing.",
  "duckduckgo.",
  "wikipedia.org",
  "yelp.",
  "tripadvisor.",
  "reddit.com",
  "quora.com",
  "youtube.com",
  "linkedin.com",
];

/** Marketplace hosts where two different shops share a domain — dedup by
 * shop path, not by host. */
const SHARED_STOREFRONTS = ["etsy.com", "facebook.com", "instagram.com"];

export interface DiscoveredCandidate {
  name: string;
  url: string;
  /** Why the search thinks they compete — shown to the owner, who decides. */
  evidence: string;
}

export type DiscoveryLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

const SYSTEM = `You find direct competitors of a small business, using web search.

Search the web (at most ${DISCOVERY_CAPS.max_searches} searches) for businesses that sell a comparable offering to comparable customers, in or serving the same location. Prefer independent businesses of a similar scale over supermarkets and giants.

Then reply with ONLY this JSON, nothing around it:
{"candidates":[{"name":"...","url":"...","evidence":"..."}]}

Rules:
- Up to ${DISCOVERY_CAPS.max_candidates} candidates. Fewer real ones beat five padded ones; an empty list is a valid answer.
- url is the business's OWN page — their site, or their own shopfront on a marketplace. Never a directory, review site, or search page.
- evidence is one short sentence from the search results saying what they sell and where — never your own guess.
- Only businesses the search results actually support. Nothing invented, nothing from memory.`;

/** The one live model call: Haiku with server-side web search. */
export const liveDiscoveryLlm: DiscoveryLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: DISCOVERY_CAPS.max_searches },
    ],
  });
  const record = buildCallRecord({
    workload: "research",
    account_id: accountId,
    model: RESEARCH_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, calls: [record] };
};

/* ── deterministic hygiene, exported for tests ── */

/** One identity per real business: host — or host + shop path on
 * marketplaces where two shops share a domain. */
export function candidateKey(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (SHARED_STOREFRONTS.some((s) => host === s || host.endsWith(`.${s}`))) {
    // Two segments, because shop URLs nest ("/shop/<name>" on etsy):
    // one segment would collapse every shop into "etsy.com/shop".
    const shop = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return `${host}/${shop.toLowerCase()}`;
  }
  return host;
}

export function cleanCandidates(
  raw: unknown,
  ownName: string | null,
): { kept: DiscoveredCandidate[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: DiscoveredCandidate[] = [];
  const seen = new Set<string>();
  const own = ownName?.trim().toLowerCase() ?? null;

  const list = Array.isArray((raw as { candidates?: unknown })?.candidates)
    ? ((raw as { candidates: unknown[] }).candidates as unknown[])
    : [];

  for (const item of list) {
    const c = item as Partial<DiscoveredCandidate>;
    const name = typeof c.name === "string" ? c.name.trim().slice(0, 120) : "";
    const url = typeof c.url === "string" ? c.url.trim() : "";
    const evidence = typeof c.evidence === "string" ? c.evidence.trim().slice(0, 240) : "";
    if (name === "" || !isPublicHttpUrl(url)) {
      dropped.push(`${name || url || "?"} · no name or usable URL`);
      continue;
    }
    const key = candidateKey(url);
    if (key === null) {
      dropped.push(`${name} · unparseable URL`);
      continue;
    }
    if (NEVER_A_COMPETITOR.some((d) => key === d || key.includes(`.${d}`) || key.startsWith(d))) {
      dropped.push(`${name} · ${key} is a directory, not a business`);
      continue;
    }
    if (own !== null && name.toLowerCase() === own) {
      dropped.push(`${name} · that is the owner's own business`);
      continue;
    }
    if (seen.has(key)) {
      dropped.push(`${name} · duplicate of ${key}`);
      continue;
    }
    seen.add(key);
    kept.push({ name, url, evidence });
    if (kept.length >= DISCOVERY_CAPS.max_candidates) break;
  }
  return { kept, dropped };
}

/** Pull the JSON object out of a reply that may have prose around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ResearchError(`discovery returned no JSON: ${text.slice(0, 160)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ResearchError(`discovery returned malformed JSON: ${text.slice(start, start + 160)}`);
  }
}

/* ── the run ── */

export interface DiscoveryResult {
  candidates: DiscoveredCandidate[];
  /** What the query was built from — the owner can see what we knew. */
  based_on: { description: string | null; sells: string | null; country: string | null };
  /** Candidates the hygiene pass removed, and why. Honesty, not noise. */
  dropped: string[];
  discovered_at: string;
  calls: readonly LlmCallRecord[];
  events: ProgressEvent[];
}

const asText = (field: Field<unknown> | null): string | null => {
  if (!field || field.status !== "answered") return null;
  const v = field.value;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((item) =>
        typeof item === "string"
          ? item
          : ((item as { label_raw?: string; value?: string })?.label_raw ??
            (item as { value?: string })?.value ??
            ""),
      )
      .filter(Boolean)
      .join(", ");
  }
  if (v !== null && typeof v === "object") {
    const o = v as { label_raw?: string; value?: string };
    return o.label_raw ?? o.value ?? null;
  }
  return null;
};

export async function discoverCompetitors(args: {
  accountId: string;
  profileId: string;
  llm?: DiscoveryLlm;
  onProgress?: ProgressSink;
}): Promise<DiscoveryResult> {
  const t0 = Date.now();
  const events: ProgressEvent[] = [];
  const emit = (step: ProgressEvent["step"], detail: string): void => {
    const event: ProgressEvent = { step, detail, elapsed_ms: Date.now() - t0 };
    events.push(event);
    args.onProgress?.(event);
  };

  // Rule 2: a profile at its competitor budget has nothing to discover into.
  const existing = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.profile_id, args.profileId));
  if (existing.length >= CAPS.max_runs_per_profile) {
    throw new ResearchError(
      `profile already holds ${existing.length} competitors, at the cap of ${CAPS.max_runs_per_profile}`,
    );
  }

  // What we know, from the owner's own answers — with provenance intact.
  const [description, sells, country, ownName] = await Promise.all([
    readCurrentField<unknown>(args.profileId, "identity.description"),
    readCurrentField<unknown>(args.profileId, "identity.sells"),
    readCurrentField<unknown>(args.profileId, "legal.country"),
    readCurrentField<unknown>(args.profileId, "identity.legal_name"),
  ]);
  const based_on = {
    description: asText(description),
    sells: asText(sells),
    country: asText(country),
  };

  // A gap is a finding — but here it is also a blocker, and the refusal
  // names exactly what is missing rather than searching for nothing.
  if (based_on.description === null && based_on.sells === null) {
    throw new ResearchError(
      "cannot discover competitors yet: the profile has neither a description of the business (1.3) nor what it sells (1.4)",
    );
  }

  const user = [
    "THE BUSINESS, IN THE OWNER'S OWN WORDS:",
    based_on.description !== null ? `- what it does: ${based_on.description}` : null,
    based_on.sells !== null ? `- what it sells: ${based_on.sells}` : null,
    based_on.country !== null ? `- country: ${based_on.country}` : null,
    "",
    "Find their direct competitors.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const llm = args.llm ?? liveDiscoveryLlm;
  const { text, calls } = await llm({ system: SYSTEM, user, accountId: args.accountId });
  emit("search", `searched the web from the owner's own facts`);

  const { kept, dropped } = cleanCandidates(extractJson(text), asText(ownName));
  emit(
    "read",
    `${kept.length} candidate${kept.length === 1 ? "" : "s"} kept` +
      (dropped.length > 0 ? `, ${dropped.length} dropped` : ""),
  );

  if (kept.length === 0) {
    throw new ResearchError(
      "the search supported no usable competitors — nothing invented in their place",
    );
  }

  // Nothing is written. The owner confirms a candidate; confirmation is
  // what runs researchCompetitor on it.
  emit("done", `finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  return {
    candidates: kept,
    based_on,
    dropped,
    discovered_at: new Date().toISOString(),
    calls,
    events,
  };
}
