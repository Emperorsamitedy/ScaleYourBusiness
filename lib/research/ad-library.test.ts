// P3-50 — the Meta Ad Library reader. What must hold:
//
//   · READ-ONLY. Only GET, only /me/permissions and /ads_archive, the token
//     in a header and never in a URL — and the source scan fails the build
//     if any of that changes. The research registry is in the build-failing
//     scope audit, and a token carrying a write permission is refused
//     before the Library is asked anything.
//   · HONEST COVERAGE. EU and UK businesses are covered; anyone else gets a
//     sentence saying the Library holds only political ads for them.
//   · MINIMAL. Only the fields the analysis needs are asked for; no
//     snapshot URL (it carries the token), no targeting, no spend.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESEARCH_SOURCE_REGISTRY, auditRegistry } from "../connectors/scopes";
import {
  AD_LIBRARY_CAPS,
  AD_LIBRARY_FIELDS,
  AdLibraryError,
  adLibraryCoverage,
  archiveParams,
  countryCode,
  createAdLibraryClient,
  libraryUrl,
  parseAd,
} from "./ad-library";
import {
  FAKE_AD_LIBRARY_TOKEN,
  ceramicsNiche,
  fakeAdLibrary,
  libraryError,
  libraryJson,
} from "./ad-library-fake";

const noSleep = async () => undefined;
const query = {
  country: "IE",
  term: "mug",
  media: "VIDEO" as const,
  delivered_since: "2025-10-26",
};

describe("P3-50 — read-only, proven", () => {
  it("THE BUILD GATE: the source names no other verb, sets no other method, puts no token in a URL", () => {
    const source = readFileSync(fileURLToPath(new URL("./ad-library.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(source).not.toMatch(/access_token=/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(['"GET"', "init.method"]).toContain(method);
  });

  it("the research registry is audited with the connectors, and stays read-only", () => {
    expect(RESEARCH_SOURCE_REGISTRY.meta_ad_library).toEqual(["public_profile"]);
    expect(auditRegistry()).toEqual([]);
    // The default audit really reads it: a write scope planted there is caught.
    expect(
      auditRegistry({ ...RESEARCH_SOURCE_REGISTRY, meta_ad_library: ["ads_management"] }),
    ).toEqual([{ provider: "meta_ad_library", scope: "ads_management", reason: "write_capable" }]);
  });

  it("sends GET with the token as a bearer header, to the two paths only", async () => {
    const fake = fakeAdLibrary({ ads: ceramicsNiche("2026-10-26") });
    const client = createAdLibraryClient({ token: FAKE_AD_LIBRARY_TOKEN, fetch: fake.fetch });
    await client.checkToken();
    await client.search(query);
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.headers["authorization"]).toBe(`Bearer ${FAKE_AD_LIBRARY_TOKEN}`);
      expect(call.url.href).not.toContain(FAKE_AD_LIBRARY_TOKEN);
      expect(call.url.origin).toBe("https://graph.facebook.com");
    }
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([
      "/v26.0/me/permissions",
      "/v26.0/ads_archive",
    ]);
  });

  it("refuses a token that carries a write permission, before asking the Library", async () => {
    const fake = fakeAdLibrary({
      permissions: [
        { permission: "public_profile", status: "granted" },
        { permission: "pages_manage_posts", status: "granted" },
      ],
    });
    const client = createAdLibraryClient({ token: FAKE_AD_LIBRARY_TOKEN, fetch: fake.fetch });
    await expect(client.checkToken()).rejects.toThrow(/pages_manage_posts/);
    expect(fake.calls.map((c) => c.url.pathname)).toEqual(["/v26.0/me/permissions"]);
  });

  it("ignores a declined permission — only granted ones count", async () => {
    const fake = fakeAdLibrary({
      permissions: [
        { permission: "public_profile", status: "granted" },
        { permission: "ads_management", status: "declined" },
      ],
    });
    const client = createAdLibraryClient({ token: FAKE_AD_LIBRARY_TOKEN, fetch: fake.fetch });
    await expect(client.checkToken()).resolves.toEqual(["public_profile"]);
  });

  it("says in words when the token is refused or the identity isn't confirmed", async () => {
    const expired = createAdLibraryClient({
      token: "wrong",
      fetch: fakeAdLibrary().fetch,
    });
    await expect(expired.checkToken()).rejects.toThrow(/didn't accept/);
    const unconfirmed = createAdLibraryClient({
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fakeAdLibrary({
        respond: (call) =>
          call.url.pathname.endsWith("/ads_archive")
            ? libraryError(10, "Application does not have permission")
            : null,
      }).fetch,
    });
    const error = await unconfirmed.search(query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdLibraryError);
    expect((error as AdLibraryError).kind).toBe("token");
    expect((error as Error).message).toMatch(/confirmed its identity/);
  });

  it("retries a rate limit at most max_attempts times, then stops", async () => {
    const fake = fakeAdLibrary({ respond: () => libraryError(613, "Calls limited") });
    const client = createAdLibraryClient({
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fake.fetch,
      sleep: noSleep,
    });
    await expect(client.search(query)).rejects.toThrow(/busy or unavailable/);
    expect(fake.calls).toHaveLength(AD_LIBRARY_CAPS.max_attempts);
  });

  it("never makes more than max_requests_per_read requests", async () => {
    const fake = fakeAdLibrary({ respond: () => libraryJson(200, { data: [] }) });
    const client = createAdLibraryClient({ token: FAKE_AD_LIBRARY_TOKEN, fetch: fake.fetch });
    for (let i = 0; i < AD_LIBRARY_CAPS.max_requests_per_read; i += 1) await client.search(query);
    await expect(client.search(query)).rejects.toThrow(/requests are used/);
    expect(fake.calls).toHaveLength(AD_LIBRARY_CAPS.max_requests_per_read);
  });
});

describe("P3-50 — what is asked for", () => {
  it("asks for commercial ads (ad_type ALL), the country, the media type and only the needed fields", () => {
    const p = archiveParams(query);
    expect(p.get("ad_type")).toBe("ALL");
    expect(p.get("ad_active_status")).toBe("ALL");
    expect(p.get("ad_reached_countries")).toBe('["IE"]');
    expect(p.get("media_type")).toBe("VIDEO");
    expect(p.get("search_terms")).toBe("mug");
    expect(p.get("search_type")).toBe("KEYWORD_UNORDERED");
    expect(p.get("limit")).toBe(String(AD_LIBRARY_CAPS.page_size));
    expect(p.get("fields")?.split(",")).toEqual([...AD_LIBRARY_FIELDS]);
    for (const never of [
      "ad_snapshot_url",
      "spend",
      "impressions",
      "target_ages",
      "beneficiary_payers",
      "bylines",
    ]) {
      expect(p.get("fields")).not.toContain(never);
    }
  });

  it("searches a competitor's pages by id (at most ten), or its name as an exact phrase", () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(1000 + i));
    const byPage = archiveParams({ ...query, term: undefined, page_ids: ids });
    expect(JSON.parse(byPage.get("search_page_ids") ?? "[]")).toHaveLength(10);
    expect(byPage.get("search_terms")).toBeNull();
    const byName = archiveParams({ ...query, term: "Saltmarsh Pottery", exact: true });
    expect(byName.get("search_type")).toBe("KEYWORD_EXACT_PHRASE");
  });

  it("minimises each ad: first body capped, counts of versions, dates, format", () => {
    const ad = parseAd(
      {
        id: "1",
        page_id: "2",
        page_name: " Kiln Lane Studio ",
        ad_creative_bodies: ["x".repeat(900), "second body", "x".repeat(900)],
        ad_creative_link_titles: ["A", "B"],
        ad_delivery_start_time: "2026-07-01T08:00:00+0000",
        publisher_platforms: ["FACEBOOK", "INSTAGRAM"],
        target_ages: ["18-65"],
        ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=1&access_token=SECRET",
      },
      "IMAGE",
      { kind: "term", term: "mug" },
    );
    expect(ad).not.toBeNull();
    expect(ad!.body.length).toBe(AD_LIBRARY_CAPS.max_body_chars);
    expect(ad!.bodies).toBe(2);
    expect(ad!.titles).toBe(2);
    expect(ad!.format).toBe("multi");
    expect(ad!.started).toBe("2026-07-01");
    expect(ad!.stopped).toBeNull();
    expect(ad!.page_name).toBe("Kiln Lane Studio");
    expect(ad!.platforms).toEqual(["facebook", "instagram"]);
    expect(JSON.stringify(ad)).not.toMatch(/SECRET|target_ages|snapshot/);
  });

  it("skips a row it can't use rather than guessing", () => {
    expect(parseAd({ id: "1", page_name: "x" }, "VIDEO", { kind: "term", term: "t" })).toBeNull();
    expect(parseAd(null, "VIDEO", { kind: "term", term: "t" })).toBeNull();
  });

  it("links to the public Library page, never the token-bearing snapshot", () => {
    expect(libraryUrl("910000000000001")).toBe(
      "https://www.facebook.com/ads/library/?id=910000000000001",
    );
  });
});

describe("P3-50 — coverage, honestly", () => {
  it("reads the owner's free-text country", () => {
    expect(countryCode("Ireland")).toBe("IE");
    expect(countryCode("hungary")).toBe("HU");
    expect(countryCode("Magyarország")).toBe("HU");
    expect(countryCode("UK")).toBe("GB");
    expect(countryCode("United States of America")).toBe("US");
    expect(countryCode("de")).toBe("DE");
    expect(countryCode("Atlantis")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });

  it("covers the EU and the UK", () => {
    expect(adLibraryCoverage("Ireland")).toEqual({ covered: true, country: "IE" });
    expect(adLibraryCoverage("Hungary")).toEqual({ covered: true, country: "HU" });
    expect(adLibraryCoverage("United Kingdom")).toEqual({ covered: true, country: "GB" });
  });

  it("says so when the business is elsewhere, or its country is unknown", () => {
    const us = adLibraryCoverage("USA");
    expect(us.covered).toBe(false);
    if (!us.covered)
      expect(us.why).toMatch(/only shows ordinary business ads that reached the EU or the UK/);
    const unknown = adLibraryCoverage(undefined);
    expect(unknown.covered).toBe(false);
    if (!unknown.covered) expect(unknown.why).toMatch(/don't know which country/);
  });
});
