// P2-33 — the Google Search Console connector, against a recorded-shape
// Google. Read-only proven (one scope asked, tokeninfo-confirmed, three
// URLs, a source scan); the arithmetic (normalised queries, position
// weighted by impressions); the sync (90 days, startRow paging, the last
// 4 days re-read).

import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Provider, PullPage } from "./provider";
import { makeServiceAccount } from "./providers/ga4-fake";
import type { ScFetch, ScRow } from "./providers/search-console";
import {
  SC_HISTORY_DAYS,
  SC_REREAD_DAYS,
  SC_SCOPE,
  aggregateQueries,
  createSearchConsoleProvider,
  normaliseSiteUrl,
  queryUrl,
} from "./providers/search-console";
import { ScopeViolationError, verifyGrantedScopes } from "./scopes";

const NOW = new Date("2026-10-13T12:00:00Z");
const SITE = "sc-domain:rival-bar.hu";
const ACCOUNT = makeServiceAccount("syb-reader@ember-oak.iam.gserviceaccount.com");
const SECRET = JSON.stringify({ site_url: SITE, service_account_json: ACCOUNT.json });

function fakeGoogle(
  opts: { rows?: ScRow[]; reportedScope?: string; user?: boolean; pageCap?: number } = {},
) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const issued = new Map<string, string>();
  let n = 0;
  const json = (status: number, body: unknown) => ({ status, json: async () => body });
  const fetch: ScFetch = async (url, init) => {
    calls.push({
      url,
      body: init.body && url.startsWith("https://searchconsole") ? JSON.parse(init.body) : null,
    });
    const u = new URL(url);
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(init.body ?? "").get("assertion") ?? "";
      const [h, p, s] = assertion.split(".");
      const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      const valid =
        h &&
        p &&
        s &&
        createVerify("RSA-SHA256").update(`${h}.${p}`).verify(ACCOUNT.publicKey, s, "base64url");
      if (!valid) return json(400, { error: "invalid_grant" });
      const token = `ya29.sc-${++n}`;
      issued.set(token, String(claims.scope));
      return json(200, { access_token: token, expires_in: 3599 });
    }
    if (u.origin + u.pathname === "https://oauth2.googleapis.com/tokeninfo") {
      // The token arrives in the header now; a token in the URL is a failure.
      if (u.searchParams.has("access_token")) return json(400, { error: "token in URL" });
      const scope = issued.get((init.headers["authorization"] ?? "").replace(/^Bearer /, ""));
      return scope === undefined
        ? json(400, { error: "invalid_token" })
        : json(200, { scope: opts.reportedScope ?? scope });
    }
    if (url === queryUrl(SITE)) {
      if (!issued.has((init.headers.authorization ?? "").replace("Bearer ", "")))
        return json(401, { error: { message: "unauthorised" } });
      if (opts.user === false)
        return json(403, {
          error: { message: "User does not have sufficient permission for site" },
        });
      const body = JSON.parse(init.body ?? "{}") as {
        startDate: string;
        endDate: string;
        rowLimit: number;
        startRow: number;
      };
      const all = (opts.rows ?? []).filter(
        (r) => r.date >= body.startDate && r.date <= body.endDate,
      );
      const limit = Math.min(body.rowLimit, opts.pageCap ?? body.rowLimit);
      const page = all.slice(body.startRow, body.startRow + limit);
      return json(200, {
        rows: page.map((r) => ({
          keys: [r.date, r.query],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.impressions ? r.clicks / r.impressions : 0,
          position: r.position,
        })),
        responseAggregationType: "byProperty",
      });
    }
    return json(404, { error: { message: "Not Found" } });
  };
  return { fetch, calls };
}

function provider(fake: ReturnType<typeof fakeGoogle>): Provider {
  return createSearchConsoleProvider({
    fetch: fake.fetch,
    sleep: async () => {},
    clock: () => NOW.getTime(),
  });
}

async function runToDone(p: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 20; i++) {
    const page = await p.pull(SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

describe("P2-33 — read-only, proven", () => {
  it("asks for webmasters.readonly only, and tokeninfo confirms it", async () => {
    const fake = fakeGoogle();
    const { granted_scopes } = await provider(fake).connect(SECRET);
    expect(granted_scopes).toEqual([SC_SCOPE]);
    expect(() => verifyGrantedScopes("search_console", granted_scopes)).not.toThrow();
  });

  it("a token reporting the full webmasters scope is refused by the registry", async () => {
    const fake = fakeGoogle({
      reportedScope: `${SC_SCOPE} https://www.googleapis.com/auth/webmasters`,
    });
    const { granted_scopes } = await provider(fake).connect(SECRET);
    expect(() => verifyGrantedScopes("search_console", granted_scopes)).toThrow(
      ScopeViolationError,
    );
  });

  it("a service account that isn't a user on the property gets the owner's next step", async () => {
    await expect(provider(fakeGoogle({ user: false })).connect(SECRET)).rejects.toThrow(
      /Users and permissions/,
    );
  });

  it("the source names one scope and three Google URLs, and nothing broader", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/search-console.ts", import.meta.url)),
      "utf8",
    );
    const hosts = new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual([
      "oauth2.googleapis.com",
      "searchconsole.googleapis.com",
      "www.example.com",
      "www.googleapis.com",
    ]);
    // www.googleapis.com appears only as the scope URL; www.example.com only in help text.
    expect(source).not.toMatch(/auth\/webmasters["'\s]/);
    expect(source).not.toMatch(/www\.googleapis\.com\/webmasters/);
  });
});

describe("P2-33 — the property and the arithmetic", () => {
  it("normalises the property as Search Console names it", () => {
    expect(normaliseSiteUrl("sc-domain:Rival-Bar.hu")).toBe("sc-domain:rival-bar.hu");
    expect(normaliseSiteUrl("https://www.rival-bar.hu")).toBe("https://www.rival-bar.hu/");
    expect(normaliseSiteUrl("rival-bar.hu")).toBeNull();
  });

  it("lower-cases and trims queries, sums those that then coincide, and weights position by impressions", () => {
    const obs = aggregateQueries(
      [
        {
          date: "2026-10-01",
          query: "Bar with Live Music ",
          clicks: 1,
          impressions: 10,
          position: 4,
        },
        {
          date: "2026-10-01",
          query: "bar with live music",
          clicks: 0,
          impressions: 30,
          position: 8,
        },
        { date: "2026-10-01", query: "rival bar", clicks: 0, impressions: 0, position: 1 },
      ],
      NOW.toISOString(),
    );
    const get = (m: string) =>
      obs.find((o) => o.metric_key === m && o.dimensions.query_ref === "bar with live music")
        ?.value_num;
    expect(get("search_impressions.daily")).toBe(40);
    expect(get("search_clicks.daily")).toBe(1);
    // (4 × 10 + 8 × 30) = 280; ÷ 40 impressions = position 7.
    expect(get("search_position_weighted.daily")).toBe(280);
    expect(obs.some((o) => o.dimensions.query_ref === "rival bar")).toBe(false); // never shown
  });
});

describe("P2-33 — the sync", () => {
  it("reads 90 days in windows, never today, paging by startRow", async () => {
    const rows: ScRow[] = Array.from({ length: 60 }, (_, i) => ({
      date: "2026-09-20",
      query: `q${i}`,
      clicks: 1,
      impressions: 2,
      position: 3,
    }));
    const fake = fakeGoogle({ rows, pageCap: 25 });
    const pages = await runToDone(provider(fake));
    expect(pages.at(-1)?.done).toBe(true);
    const days = new Set(pages.flatMap((p) => p.observations.map((o) => o.period_date)));
    expect([...days]).toEqual(["2026-09-20"]);
    expect(
      pages
        .flatMap((p) => p.observations)
        .filter((o) => o.metric_key === "search_impressions.daily"),
    ).toHaveLength(60);
    const bodies = fake.calls
      .filter((c) => c.body)
      .map((c) => c.body as { startDate: string; endDate: string; startRow: number });
    expect(bodies.some((b) => b.startRow === 25)).toBe(true);
    expect(bodies.every((b) => b.endDate <= "2026-10-12")).toBe(true);
    expect(bodies[0]?.startDate).toBe(
      new Date(Date.UTC(2026, 9, 12 - (SC_HISTORY_DAYS - 1))).toISOString().slice(0, 10),
    );
  });

  it("a caught-up sync re-reads the last 4 days, which Google may still be filling", async () => {
    const fake = fakeGoogle();
    const page = await provider(fake).pull(SECRET, "2026-10-12", NOW);
    const body = fake.calls.find((c) => c.body)?.body as { startDate: string; endDate: string };
    expect(body.endDate).toBe("2026-10-12");
    expect(body.startDate).toBe(`2026-10-${String(12 - SC_REREAD_DAYS + 1).padStart(2, "0")}`);
    expect(page.done).toBe(true);
  });
});
