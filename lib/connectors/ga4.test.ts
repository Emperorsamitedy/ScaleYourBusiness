// P2-18 — the Google Analytics 4 connector, against a recorded-shape Google.
//
// The fake is strict where it counts: it verifies the JWT's RS256 signature
// against a real generated service account key, reports the scope that JWT
// asked for, and answers reports only for the property the account can
// view. What these tests hold:
//
//   · READ-ONLY, PROVEN. The only scope ever requested is analytics.readonly,
//     tokeninfo confirms it, a broader token is refused by the registry, and
//     requests go to exactly three Google URLs, never the key file's token_uri.
//   · THE ARITHMETIC. Sessions summed across channels for the business total,
//     per-channel rows kept, YYYYMMDD dates, zero days.
//   · THE SYNC. A year in windows, offset paging, the last 3 days re-read.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation, Provider, PullPage } from "./provider";
import { ProviderError } from "./provider";
import {
  GA4_DATA_ORIGIN,
  GA4_HISTORY_DAYS,
  GA4_MAX_ATTEMPTS,
  GA4_REREAD_DAYS,
  GA4_SCOPE,
  GA4_TOKENINFO_URL,
  GA4_TOKEN_URL,
  aggregateSessions,
  createGa4Provider,
  parseGa4Credential,
} from "./providers/ga4";
import type { FakeGa4, FakeGa4Options } from "./providers/ga4-fake";
import { fakeGa4, ga4Json, makeServiceAccount } from "./providers/ga4-fake";
import { ScopeViolationError, verifyGrantedScopes } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");
const PROPERTY = "412345678";
const ACCOUNT = makeServiceAccount();
const SECRET = JSON.stringify({ property_id: PROPERTY, service_account_json: ACCOUNT.json });

function ga4(overrides: Partial<FakeGa4Options> = {}): { fake: FakeGa4; provider: Provider } {
  const fake = fakeGa4({ account: ACCOUNT, propertyId: PROPERTY, ...overrides });
  const provider = createGa4Provider({
    fetch: fake.fetch,
    sleep: async () => {},
    clock: () => NOW.getTime(),
  });
  return { fake, provider };
}

async function runToDone(provider: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 100; i += 1) {
    const page = await provider.pull(SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

const totalDays = (obs: readonly Observation[]): string[] =>
  obs
    .filter((o) => o.metric_key === "sessions.daily" && o.dimensions.channel_ref === undefined)
    .map((o) => o.period_date);
const totalSessions = (obs: readonly Observation[]): number =>
  obs
    .filter((o) => o.metric_key === "sessions.daily" && o.dimensions.channel_ref === undefined)
    .reduce((s, o) => s + (o.value_num ?? 0), 0);
const channelSessions = (obs: readonly Observation[], channel: string): number =>
  obs
    .filter((o) => o.metric_key === "sessions.daily" && o.dimensions.channel_ref === channel)
    .reduce((s, o) => s + (o.value_num ?? 0), 0);

describe("P2-18 — the credential", () => {
  it("accepts a property ID with or without the properties/ prefix", () => {
    const parsed = parseGa4Credential(
      JSON.stringify({ property_id: `properties/${PROPERTY}`, service_account_json: ACCOUNT.json }),
    );
    expect(parsed.property_id).toBe(PROPERTY);
    expect(parsed.client_email).toBe(ACCOUNT.email);
  });

  it("refuses a non-numeric property, a non-JSON key, and a key that isn't a service account", () => {
    expect(() =>
      parseGa4Credential(
        JSON.stringify({ property_id: "G-ABC123", service_account_json: ACCOUNT.json }),
      ),
    ).toThrow(/property ID/);
    expect(() =>
      parseGa4Credential(
        JSON.stringify({ property_id: PROPERTY, service_account_json: "not json" }),
      ),
    ).toThrow(/JSON/);
    expect(() =>
      parseGa4Credential(
        JSON.stringify({
          property_id: PROPERTY,
          service_account_json: JSON.stringify({
            type: "authorized_user",
            client_email: "me@gmail.com",
          }),
        }),
      ),
    ).toThrow(/service account key/);
  });
});

describe("P2-18 — connecting proves read-only access", () => {
  it("signs a read-only JWT, confirms the scope with Google, and probes the property", async () => {
    const { fake, provider } = ga4();
    const result = await provider.connect(SECRET);

    expect(result.granted_scopes).toEqual([GA4_SCOPE]);
    const tokenCall = fake.calls.find((c) => c.claims !== null);
    expect(tokenCall?.claims).toMatchObject({
      iss: ACCOUNT.email,
      scope: GA4_SCOPE,
      aud: GA4_TOKEN_URL,
    });
    expect(Number(tokenCall?.claims?.["exp"]) - Number(tokenCall?.claims?.["iat"])).toBe(3600);
    expect(fake.calls.some((c) => `${c.url.origin}${c.url.pathname}` === GA4_TOKENINFO_URL)).toBe(
      true,
    );
  });

  it("RULE 9, FOR REAL: a token Google reports as broader than read-only is refused", async () => {
    const { provider } = ga4({
      reportedScope: `${GA4_SCOPE} https://www.googleapis.com/auth/analytics.edit`,
    });
    const { granted_scopes } = await provider.connect(SECRET);
    expect(() => verifyGrantedScopes("ga4", granted_scopes)).toThrow(ScopeViolationError);
  });

  it("a property the service account can't view names the account and the fix", async () => {
    const { provider } = ga4({ viewer: false });
    await expect(provider.connect(SECRET)).rejects.toThrow(
      new RegExp(`${ACCOUNT.email.replace(/\./g, "\\.")} can't read property ${PROPERTY}.*Viewer`),
    );
  });

  it("a key Google rejects is reported without echoing the private key", async () => {
    const stranger = makeServiceAccount("someone-else@other.iam.gserviceaccount.com");
    const { provider } = ga4();
    const secret = JSON.stringify({ property_id: PROPERTY, service_account_json: stranger.json });
    try {
      await provider.connect(secret);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toMatch(/did not accept/);
      expect((error as Error).message).not.toContain("PRIVATE KEY");
    }
  });
});

describe("rule 9 — the connector can only read", () => {
  it("talks to exactly three Google URLs, and ignores the key file's token_uri", async () => {
    const doctored = makeServiceAccount(ACCOUNT.email, "https://evil.example.com/token");
    const secret = JSON.stringify({ property_id: PROPERTY, service_account_json: doctored.json });
    const fake = fakeGa4({
      account: doctored,
      propertyId: PROPERTY,
      rows: [{ date: "2026-09-10", channel: "Direct", sessions: 5 }],
    });
    const provider = createGa4Provider({
      fetch: fake.fetch,
      sleep: async () => {},
      clock: () => NOW.getTime(),
    });
    await provider.connect(secret);
    await provider.pull(secret, null, NOW);
    await provider.listChannels?.(secret);

    const allowed = [
      GA4_TOKEN_URL,
      GA4_TOKENINFO_URL,
      `${GA4_DATA_ORIGIN}/v1beta/properties/${PROPERTY}:runReport`,
    ];
    for (const call of fake.calls) {
      expect(allowed).toContain(`${call.url.origin}${call.url.pathname}`);
    }
  });

  it("THE BUILD GATE: only the read-only scope and the three known hosts appear in the source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/ga4.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/auth\/analytics["'`]/);
    expect(source).not.toMatch(/analytics\.(edit|manage)/);
    const hosts = new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual(
      ["analyticsdata.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"].sort(),
    );
  });
});

describe("P2-18 — the arithmetic", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-09-03T00:00:00Z");
  const obs = aggregateSessions(
    [
      { date: "2026-09-01", channel: "Organic Search", sessions: 40 },
      { date: "2026-09-01", channel: "Direct", sessions: 25 },
      { date: "2026-09-01", channel: "Paid Social", sessions: 0 },
      { date: "2026-09-02", channel: "Direct", sessions: 10 },
      { date: "2026-08-31", channel: "Direct", sessions: 999 },
    ],
    start,
    end,
    NOW.toISOString(),
  );

  it("the business total is the sum of channels, with zero days", () => {
    expect(totalDays(obs)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(
      obs.find((o) => o.period_date === "2026-09-01" && !o.dimensions.channel_ref)?.value_num,
    ).toBe(65);
    expect(
      obs.find((o) => o.period_date === "2026-09-03" && !o.dimensions.channel_ref)?.value_num,
    ).toBe(0);
  });

  it("keeps per-channel rows only for channels with sessions", () => {
    expect(channelSessions(obs, "Organic Search")).toBe(40);
    expect(channelSessions(obs, "Direct")).toBe(35);
    expect(obs.some((o) => o.dimensions.channel_ref === "Paid Social")).toBe(false);
  });
});

describe("P2-18 — the sync", () => {
  it("reads a year in windows and converts GA4's YYYYMMDD dates", async () => {
    const { provider } = ga4({
      rows: [
        { date: "2025-10-01", channel: "Direct", sessions: 12 },
        { date: "2026-09-13", channel: "Organic Search", sessions: 30 },
        { date: "2026-09-13", channel: "Direct", sessions: 8 },
        { date: "2026-09-14", channel: "Direct", sessions: 500 }, // today: not read
      ],
    });
    const pages = await runToDone(provider);
    const all = pages.flatMap((p) => p.observations);
    expect(totalDays(all)).toHaveLength(GA4_HISTORY_DAYS);
    expect(totalSessions(all)).toBe(50);
    expect(channelSessions(all, "Organic Search")).toBe(30);
    expect(pages.at(-1)).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("follows offset paging when the report is bigger than one response", async () => {
    const channels = [
      "Direct",
      "Email",
      "Organic Search",
      "Organic Social",
      "Paid Search",
      "Referral",
    ];
    const rows = Array.from({ length: 30 }, (_, day) =>
      channels.map((channel) => ({
        date: new Date(Date.UTC(2026, 7, 15 + day)).toISOString().slice(0, 10),
        channel,
        sessions: 1,
      })),
    ).flat();
    const { fake, provider } = ga4({ rows, maxRows: 50 });
    const page = await provider.pull(SECRET, "2026-08-14", NOW);
    expect(totalSessions(page.observations)).toBe(180);
    const reportCalls = fake.calls.filter((c) => c.url.origin === GA4_DATA_ORIGIN);
    expect(reportCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("a daily run re-reads the last 3 days, which GA4 may still be processing", async () => {
    const { provider } = ga4();
    const page = await provider.pull(SECRET, "2026-09-12", NOW);
    expect(totalDays(page.observations)).toHaveLength(GA4_REREAD_DAYS);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("server errors retry to the cap", async () => {
    const { fake, provider } = ga4({
      respond: (call) =>
        call.url.origin === GA4_DATA_ORIGIN
          ? ga4Json(503, { error: { message: "unavailable" } })
          : null,
    });
    await expect(provider.pull(SECRET, null, NOW)).rejects.toThrow(/status 503/);
    expect(fake.calls.filter((c) => c.url.origin === GA4_DATA_ORIGIN)).toHaveLength(
      GA4_MAX_ATTEMPTS,
    );
  });
});

describe("P2-29/34 — attention by hour, landing pages, site search", () => {
  const rows = [
    // Summer: Budapest is UTC+2, so 20:00 local is 18:00Z.
    {
      date: "2026-09-10",
      channel: "Organic Search",
      sessions: 7,
      hour: 20,
      landing: "/menu",
      bounces: 2,
    },
    { date: "2026-09-10", channel: "Direct", sessions: 3, hour: 20, landing: "/", bounces: 3 },
    { date: "2026-09-10", channel: "Direct", sessions: 1, hour: 0, landing: "/", bounces: 0 },
    {
      date: "2026-09-10",
      channel: "Direct",
      sessions: 0,
      searchTerm: "Vegan Options ",
      searches: 4,
    },
    {
      date: "2026-09-11",
      channel: "Direct",
      sessions: 0,
      searchTerm: "vegan options",
      searches: 1,
    },
  ];

  it("sessions per hour land in UTC from the property's zone, with every report on the one read-only URL", async () => {
    const { fake, provider } = ga4({ rows });
    const page = await provider.pull(SECRET, "2026-09-09", NOW);
    const hourly = page.observations.filter((o) => o.metric_key === "sessions.hourly");
    expect(hourly).toContainEqual(
      expect.objectContaining({
        period_date: "2026-09-10",
        dimensions: { hour_utc: "18" },
        value_num: 10,
      }),
    );
    // 00:00 on the 10th in Budapest is 22:00Z on the 9th.
    expect(hourly).toContainEqual(
      expect.objectContaining({
        period_date: "2026-09-09",
        dimensions: { hour_utc: "22" },
        value_num: 1,
      }),
    );
    const reportBodies = fake.calls
      .filter((c) => c.url.origin === GA4_DATA_ORIGIN)
      .map((c) => JSON.parse(c.init.body ?? "{}") as { dimensions: { name: string }[] });
    expect(reportBodies.map((b) => b.dimensions.map((d) => d.name).join(","))).toEqual([
      "date,sessionDefaultChannelGroup",
      "dateHour",
      "date,landingPage",
      "date,searchTerm",
    ]);
  });

  it("a property whose zone isn't stated gets no hourly rows rather than misplaced ones", async () => {
    const { provider } = ga4({ rows, timeZone: null });
    const page = await provider.pull(SECRET, "2026-09-09", NOW);
    expect(page.observations.some((o) => o.metric_key === "sessions.hourly")).toBe(false);
  });

  it("landing pages carry sessions and bounced sessions; site search counts normalised terms", async () => {
    const { provider } = ga4({ rows });
    const obs = (await provider.pull(SECRET, "2026-09-09", NOW)).observations;
    const landing = (metric: string, page: string) =>
      obs.find(
        (o) =>
          o.metric_key === metric &&
          o.period_date === "2026-09-10" &&
          o.dimensions.page_ref === page,
      )?.value_num;
    expect(landing("landing_sessions.daily", "/menu")).toBe(7);
    expect(landing("landing_bounces.daily", "/menu")).toBe(2);
    expect(landing("landing_sessions.daily", "/")).toBe(4);
    expect(landing("landing_bounces.daily", "/")).toBe(3);
    const searches = obs.filter((o) => o.metric_key === "site_search.daily");
    expect(searches).toEqual([
      expect.objectContaining({
        period_date: "2026-09-10",
        dimensions: { term_ref: "vegan options" },
        value_num: 4,
      }),
      expect.objectContaining({
        period_date: "2026-09-11",
        dimensions: { term_ref: "vegan options" },
        value_num: 1,
      }),
    ]);
    // None of these leak into the business-wide sessions total.
    expect(totalSessions(obs)).toBe(11);
  });
});

describe("P2-18 — listing channels for matching", () => {
  it("returns the property's channel groups, busiest first", async () => {
    const { provider } = ga4({
      rows: [
        { date: "2026-08-20", channel: "Direct", sessions: 5 },
        { date: "2026-08-20", channel: "Organic Search", sessions: 40 },
        { date: "2026-08-21", channel: "Paid Social", sessions: 12 },
      ],
    });
    const channels = (await provider.listChannels?.(SECRET)) ?? [];
    expect(channels.map((c) => c.ref)).toEqual(["Organic Search", "Paid Social", "Direct"]);
  });
});
