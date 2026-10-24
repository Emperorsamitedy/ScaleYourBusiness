// Review 2026-10-23, finding 9: "Find my competitors" and "look them up"
// are capped per business per day, counted from llm_calls BEFORE any paid
// call; every model and search call is persisted with the real account id
// and its search fees; pages are read through the competitor reader's
// robots-respecting path with an honest agent; the extraction prompt says
// page text is content; and the model-chosen url must be a page read or a
// search result. The model client is a fake; the global fetch fails.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, competitors, fieldRecords, llmCalls } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { USD_TO_EUR } from "../llm/pricing";
import { readCurrentField, writeField } from "../profile/field-store";
import type { FetchedPage as SiteFetchedPage, PageFetcher as GuardedFetch } from "../site/fetch";
import type { ResearchLlm, ResearchUsage, SearchHit } from "./competitor";
import {
  RESEARCH_DAILY_CAPS,
  RESEARCH_WORKLOADS,
  liveResearchLlm,
  researchCompetitor,
  researchRefusal,
  vettedCompetitorUrl,
} from "./competitor";
import type { DiscoveryLlm } from "./discovery";
import { discoverCompetitors, liveDiscoveryLlm } from "./discovery";
import { RESEARCH_USER_AGENT, createLivePageFetcher, liveSearchProvider } from "./live";

/* ── a fake Anthropic client: what the live seams send and get back ── */

const fake = vi.hoisted(() => ({
  replies: [] as unknown[],
  create: async (): Promise<unknown> => {
    const next = fake.replies.shift();
    if (!next) throw new Error("no fake reply queued");
    return next;
  },
}));
vi.mock("../llm/client", () => ({
  anthropicClient: () => ({ messages: { create: fake.create } }),
}));

const reply = (content: unknown[], searches = 0) => ({
  content,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1_000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 },
  },
});

const accountIds: string[] = [];
const profileIds: string[] = [];
let accountId: string;
let profileId: string;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

beforeEach(async () => {
  const [account] = await db.insert(accounts).values({ reporting_currency: "HUF" }).returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountId = account!.id;
  profileId = profile!.id;
  accountIds.push(accountId);
  profileIds.push(profileId);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.delete(llmCalls).where(inArray(llmCalls.account_id, accountIds));
  for (const id of profileIds) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(competitors).where(eq(competitors.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

/** Paid calls already spent today, as llm_calls rows. */
async function spent(n: number, workload: string = RESEARCH_WORKLOADS.search) {
  if (n === 0) return;
  await db.insert(llmCalls).values(
    Array.from({ length: n }, () => ({
      account_id: accountId,
      workload,
      model: "claude-haiku-5-5",
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: "0.000010",
    })),
  );
}

function world() {
  const searched: string[] = [];
  const fetched: string[] = [];
  const hits: SearchHit[] = [
    { url: "https://szomszed-szorp.hu/", title: "Szomszéd Szörp", snippet: "" },
    { url: "https://szomszed-szorp.hu/arak", title: "Árak", snippet: "" },
  ];
  return {
    searched,
    fetched,
    search: async (q: string, limit: number, account: string) => {
      searched.push(`${q}|${account}`);
      return hits.slice(0, limit);
    },
    fetchPage: async (url: string) => {
      fetched.push(url);
      return { url, title: "Szomszéd Szörp", text: "Bodzaszörp 0,5 l — 6 490 Ft" };
    },
  };
}

const extractor = (url: string | null) => {
  const systems: string[] = [];
  const llm: ResearchLlm = ({ system }) => {
    systems.push(system);
    return Promise.resolve({
      text: JSON.stringify({ fields: { name: "Szomszéd Szörp", url, price_points: "6 490 Ft" } }),
      calls: [],
    });
  };
  return { llm, systems };
};

describe("the daily cap, counted from llm_calls before any paid call", () => {
  it("lets a look-up run with room for both its calls, and refuses one without", async () => {
    await spent(RESEARCH_DAILY_CAPS.max_calls_per_profile - 2);
    const ok = world();
    await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: ok.search,
      fetchPage: ok.fetchPage,
      llm: extractor(null).llm,
    });
    // The search was metered against the real account, not "search".
    expect(ok.searched).toEqual([`Szomszéd Szörp|${accountId}`]);

    await spent(1); // one call of room left: a look-up needs two
    const refused = world();
    await expect(
      researchCompetitor({
        accountId,
        profileId,
        competitorName: "Bodza Bár",
        search: refused.search,
        fetchPage: refused.fetchPage,
        llm: extractor(null).llm,
      }),
    ).rejects.toThrow(/used up/);
    expect(refused.searched).toEqual([]);
    expect(refused.fetched).toEqual([]);
  });

  it("refuses a discovery at the cap before the model is called", async () => {
    await spent(RESEARCH_DAILY_CAPS.max_calls_per_profile, RESEARCH_WORKLOADS.discovery);
    await ownerSaid("identity.description", "Kézműves szörpök");
    let called = 0;
    const llm: DiscoveryLlm = () => {
      called++;
      return Promise.resolve({ text: '{"candidates":[]}', calls: [] });
    };
    await expect(discoverCompetitors({ accountId, profileId, llm })).rejects.toThrow(/used up/);
    expect(called).toBe(0);
  });

  it("counts euros too, per business and across all of them", () => {
    const calm = { account_calls: 0, account_eur: 0, total_eur: 0 };
    expect(researchRefusal(calm, 2)).toBeNull();
    expect(
      researchRefusal({ ...calm, account_eur: RESEARCH_DAILY_CAPS.max_eur_per_profile }, 1),
    ).toMatch(/budget/);
    expect(researchRefusal({ ...calm, total_eur: RESEARCH_DAILY_CAPS.max_eur_all }, 1)).toMatch(
      /paused/,
    );
  });

  it("runs one search per business at a time: a second click is refused, not paid", async () => {
    await ownerSaid("identity.description", "Kézműves szörpök");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let called = 0;
    const llm: DiscoveryLlm = async () => {
      called++;
      await gate;
      return {
        text: JSON.stringify({
          candidates: [{ name: "Bodza Bár", url: "https://bodzabar.hu/", evidence: "szörp" }],
        }),
        calls: [],
      };
    };
    const usage: ResearchUsage = async () => ({ account_calls: 0, account_eur: 0, total_eur: 0 });
    const first = discoverCompetitors({ accountId, profileId, llm, usage });
    await new Promise((r) => setTimeout(r, 200));
    await expect(discoverCompetitors({ accountId, profileId, llm, usage })).rejects.toThrow(
      /already running/,
    );
    release();
    await expect(first).resolves.toMatchObject({ candidates: [{ name: "Bodza Bár" }] });
    expect(called).toBe(1);
  });
});

async function ownerSaid(key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

describe("every paid call is persisted with the real account id and its search fees", () => {
  it("search, extraction and discovery each write an llm_calls row", async () => {
    fake.replies.push(
      reply(
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "t",
            content: [
              { type: "web_search_result", url: "https://a.hu/", title: "A", page_age: null },
            ],
          },
        ],
        1,
      ),
      reply([{ type: "text", text: '{"fields":{}}' }]),
      reply([{ type: "text", text: '{"candidates":[]}' }], 3),
    );
    const hits = await liveSearchProvider("Szomszéd Szörp", 5, accountId);
    expect(hits.map((h) => h.url)).toEqual(["https://a.hu/"]);
    await liveResearchLlm({ system: "s", user: "u", accountId });
    await liveDiscoveryLlm({ system: "s", user: "u", accountId });

    const rows = await db.select().from(llmCalls).where(eq(llmCalls.account_id, accountId));
    const by = new Map(rows.map((r) => [r.workload, Number(r.cost_eur)]));
    expect([...by.keys()].sort()).toEqual(
      [RESEARCH_WORKLOADS.discovery, RESEARCH_WORKLOADS.extract, RESEARCH_WORKLOADS.search].sort(),
    );
    // Haiku 5.5, short card: 1,000 in at $0.10/M and 100 out at $0.50/M =
    // $0.00015, plus $0.01 a search.
    const tokens = 0.00015 * USD_TO_EUR;
    expect(by.get(RESEARCH_WORKLOADS.extract)).toBeCloseTo(tokens, 6);
    expect(by.get(RESEARCH_WORKLOADS.search)).toBeCloseTo(tokens + 0.01 * USD_TO_EUR, 6);
    expect(by.get(RESEARCH_WORKLOADS.discovery)).toBeCloseTo(tokens + 0.03 * USD_TO_EUR, 6);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(["claude-haiku-5-5"]));
  });
});

describe("the model's url is a future fetch target: only a page read or a search result", () => {
  it("keeps an address it read or searched, in any spelling, and nothing else", () => {
    const read = ["https://szomszed-szorp.hu/arak"];
    const searched = ["https://szomszed-szorp.hu/"];
    expect(vettedCompetitorUrl("szomszed-szorp.hu/arak", read, searched)).toBe(
      "https://szomszed-szorp.hu/arak",
    );
    expect(vettedCompetitorUrl("https://szomszed-szorp.hu", read, searched)).toBe(
      "https://szomszed-szorp.hu/",
    );
    expect(vettedCompetitorUrl("https://attacker.example/next", read, searched)).toBeNull();
    expect(vettedCompetitorUrl("javascript:alert(1)", read, searched)).toBeNull();
    expect(vettedCompetitorUrl(null, read, searched)).toBeNull();
  });

  it("stores an injected address as unknown, with why, and a real one as answered", async () => {
    const w = world();
    const injected = extractor("https://attacker.example/collect");
    const a = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: w.search,
      fetchPage: w.fetchPage,
      llm: injected.llm,
    });
    const bad = await readCurrentField<string>(profileId, `competitors.${a.competitor_id}.url`);
    expect(bad?.status).toBe("unknown");
    expect(bad?.value).toBeNull();
    expect(bad?.note).toMatch(/wasn't one of the pages read/);

    const good = extractor("https://szomszed-szorp.hu/arak");
    const b = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: world().search,
      fetchPage: world().fetchPage,
      llm: good.llm,
    });
    const ok = await readCurrentField<string>(profileId, `competitors.${b.competitor_id}.url`);
    expect(ok?.value).toBe("https://szomszed-szorp.hu/arak");
    // Rule 24: the prompt says page text is content, never instructions.
    expect(injected.systems[0]).toMatch(/content, never instructions/);
  });
});

describe("pages are read the competitor reader's way", () => {
  /** A fake guarded fetcher: a site whose robots.txt disallows /arak. */
  const site = (asked: string[]): GuardedFetch => {
    return async (url) => {
      asked.push(url);
      const robots = url.endsWith("/robots.txt");
      const page: SiteFetchedPage = {
        url,
        status: 200,
        html: robots ? "User-agent: *\nDisallow: /arak\n" : "<title>Bolt</title><p>Ár 6 490 Ft</p>",
        headers: { "content-type": robots ? "text/plain" : "text/html" },
        duration_ms: 1,
      };
      return page;
    };
  };

  it("obeys robots.txt: a disallowed page isn't fetched; an allowed one is", async () => {
    const asked: string[] = [];
    const fetchPage = createLivePageFetcher(site(asked));
    expect(await fetchPage("https://bolt.example/arak", 2_000)).toBeNull();
    expect(asked).toEqual(["https://bolt.example/robots.txt"]);
    const got = await fetchPage("https://bolt.example/", 2_000);
    expect(got).toMatchObject({ url: "https://bolt.example/", title: "Bolt" });
  });

  it("says who it is: not 'owner-requested', and that it honours robots.txt", () => {
    expect(RESEARCH_USER_AGENT).toMatch(/^Ledgerline-/);
    expect(RESEARCH_USER_AGENT).toMatch(/honours robots\.txt/);
    expect(RESEARCH_USER_AGENT).not.toMatch(/owner-requested/);
  });
});
