// I-45a — the GET-only fence, as a build gate. Google's one Business Profile
// scope can write; SYB's client can't. Three holds, each with a planted case
// that must fail:
//
//   1. The endpoint list is exactly these four, every one a GET but Google's
//      OAuth token endpoint, and no path on it reaches a reply, an update or
//      a delete (anchored patterns: no extra segment matches).
//   2. gbpRequest refuses, before fetch, any request not on the list or not
//      sent with its endpoint's method.
//   3. The source: no file in lib/google-business names PUT, PATCH or DELETE
//      in code, POST appears only on the token endpoint's line, and nothing
//      calls fetch except through gbpRequest. Nowhere else in the app talks
//      to the Business Profile APIs.
//
// No network: global fetch is stubbed to fail, and the fence is checked with
// a fetch that records whether it was ever reached.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GBP_ENDPOINTS,
  GBP_SCOPE,
  GbpRequestError,
  allowedEndpoint,
  gbpRequest,
  listReviewsPage,
  readReview,
} from "./client";
import { fakeGoogle } from "./fake";

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterAll(() => vi.unstubAllGlobals());

const REVIEWS = "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews";

describe("I-45a — the endpoint list (THE BUILD GATE)", () => {
  it("is exactly these, each a GET but the OAuth token exchange", () => {
    const shape = Object.fromEntries(
      Object.entries(GBP_ENDPOINTS).map(([id, e]) => [
        id,
        `${e.method} ${e.origin} ${e.path.source.replace(/\\\//g, "/")}`,
      ]),
    );
    expect(shape).toEqual({
      token: "POST https://oauth2.googleapis.com ^/token$",
      accounts: "GET https://mybusinessaccountmanagement.googleapis.com ^/v1/accounts$",
      locations:
        "GET https://mybusinessbusinessinformation.googleapis.com ^/v1/accounts/[A-Za-z0-9_-]+/locations$",
      reviews:
        "GET https://mybusiness.googleapis.com ^/v4/accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/reviews$",
    });
    expect(GBP_SCOPE).toBe("https://www.googleapis.com/auth/business.manage");
  });

  it("allows the reads and the token exchange", () => {
    expect(allowedEndpoint("GET", `${REVIEWS}?pageSize=50&pageToken=abc`)).toBe("reviews");
    expect(
      allowedEndpoint("GET", "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"),
    ).toBe("accounts");
    expect(
      allowedEndpoint(
        "GET",
        "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations?readMask=name",
      ),
    ).toBe("locations");
    expect(allowedEndpoint("POST", "https://oauth2.googleapis.com/token")).toBe("token");
  });

  it("refuses every write Google's API has, planted deliberately", () => {
    const reply = `${REVIEWS}/333/reply`;
    // reviews.updateReply and reviews.deleteReply
    expect(allowedEndpoint("PUT", reply)).toBeNull();
    expect(allowedEndpoint("DELETE", reply)).toBeNull();
    expect(allowedEndpoint("GET", reply)).toBeNull();
    expect(allowedEndpoint("POST", REVIEWS)).toBeNull();
    // Editing the listing.
    expect(
      allowedEndpoint(
        "PATCH",
        "https://mybusinessbusinessinformation.googleapis.com/v1/locations/222",
      ),
    ).toBeNull();
    expect(
      allowedEndpoint(
        "POST",
        "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations",
      ),
    ).toBeNull();
    // Revoking at Google, or reading the token endpoint, or a look-alike host.
    expect(allowedEndpoint("POST", "https://oauth2.googleapis.com/revoke")).toBeNull();
    expect(allowedEndpoint("GET", "https://oauth2.googleapis.com/token")).toBeNull();
    expect(allowedEndpoint("GET", REVIEWS.replace("https:", "http:"))).toBeNull();
    expect(allowedEndpoint("GET", REVIEWS.replace("mybusiness.", "mybusiness.evil."))).toBeNull();
    expect(
      allowedEndpoint(
        "GET",
        `https://u:p@mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews`,
      ),
    ).toBeNull();
    // A path smuggled through a name.
    expect(
      allowedEndpoint(
        "GET",
        "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/3/reply",
      ),
    ).toBeNull();
  });
});

describe("I-45a — gbpRequest refuses before it sends", () => {
  it("a request off the list never reaches fetch", async () => {
    const seen: string[] = [];
    const spy = async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    };
    await expect(gbpRequest("reviews", `${REVIEWS}/333/reply`, {}, spy)).rejects.toMatchObject({
      kind: "fence",
    });
    await expect(gbpRequest("accounts", REVIEWS, {}, spy)).rejects.toBeInstanceOf(GbpRequestError);
    await expect(
      gbpRequest("reviews", REVIEWS, { body: new URLSearchParams({ comment: "x" }) }, spy),
    ).rejects.toMatchObject({ kind: "fence" });
    expect(seen).toEqual([]);
  });

  it("an on-list read is sent as a GET, and only as a GET", async () => {
    const fake = fakeGoogle({ reviews: {} });
    await gbpRequest("reviews", REVIEWS, {}, fake.fetch);
    expect(fake.requests).toEqual([{ method: "GET", url: REVIEWS }]);
  });

  it("a location name carrying extra segments is refused before any request", async () => {
    const fake = fakeGoogle();
    await expect(
      listReviewsPage(
        "t",
        { account: "accounts/1", location: "locations/2/reviews/3" },
        null,
        fake.fetch,
      ),
    ).rejects.toMatchObject({ kind: "fence" });
    expect(fake.requests).toEqual([]);
  });

  it("Google's answers become fixed kinds, never Google's text", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "permission"],
      [404, "refused"],
    ] as const) {
      const f = fakeGoogle({ reviewsStatus: status });
      await expect(gbpRequest("reviews", REVIEWS, {}, f.fetch)).rejects.toMatchObject({ kind });
      expect(f.requests).toHaveLength(1);
    }
    // 429 and 5xx are tried twice, then reported.
    const busy = fakeGoogle({ reviewsStatus: 503 });
    await expect(gbpRequest("reviews", REVIEWS, {}, busy.fetch)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(busy.requests).toHaveLength(2);
  });
});

/* ── the source scan ── */

const DIR = path.resolve(process.cwd(), "lib/google-business");

function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "fake.ts")
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));
}

/** Pure: code lines only — comments may name a verb; code may not use one. */
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

/** Pure: what in this source breaks the fence. */
export function fenceBreaks(text: string): string[] {
  const out: string[] = [];
  for (const line of codeLines(text)) {
    if (/\b(PUT|PATCH|DELETE)\b/.test(line)) out.push(`verb: ${line}`);
    if (
      /\bPOST\b/.test(line) &&
      !line.startsWith('token: { method: "POST", origin: "https://oauth2.googleapis.com"')
    )
      out.push(`post: ${line}`);
    if (/\bfetch\s*\(/.test(line)) out.push(`fetch: ${line}`);
  }
  return out;
}

describe("I-45a — the source holds the fence (THE BUILD GATE)", () => {
  it("no file in lib/google-business sends anything but GETs and the token exchange", () => {
    const files = sources(DIR);
    expect(files.map((f) => f.file)).toContain("client.ts");
    const breaks = files.flatMap((f) => fenceBreaks(f.text).map((b) => `${f.file}: ${b}`));
    // The one GET/POST type alias names the verbs as a type, not a request.
    expect(breaks.filter((b) => !b.includes('export type GbpMethod = "GET" | "POST";'))).toEqual(
      [],
    );
  });

  it("the scan bites: a planted PUT, a second POST and a bare fetch are each caught", () => {
    expect(fenceBreaks('const r = await f(url, { method: "PUT" });')).toHaveLength(1);
    expect(
      fenceBreaks('reply: { method: "POST", origin: "https://mybusiness.googleapis.com" },'),
    ).toHaveLength(1);
    expect(fenceBreaks("await fetch(url);")).toHaveLength(1);
    expect(fenceBreaks("// a comment may say PUT or fetch(x)")).toEqual([]);
  });

  it("nothing outside lib/google-business talks to the Business Profile APIs", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !full.startsWith(DIR)) {
          if (/mybusiness[a-z]*\.googleapis\.com/.test(readFileSync(full, "utf8")))
            offenders.push(full);
        }
      }
    };
    for (const top of ["app", "lib", "components", "scripts"])
      walk(path.resolve(process.cwd(), top));
    expect(offenders).toEqual([]);
  });
});

describe("I-45a — reading a review", () => {
  const base = {
    name: "accounts/1/locations/2/reviews/r1",
    reviewId: "r1",
    starRating: "TWO",
    comment: "  Waited forty minutes.  ",
    createTime: "2026-10-30T10:00:00Z",
    reviewer: { displayName: "Aoife M." },
  };

  it("keeps the stars, the words, the public name and the date", () => {
    expect(readReview(base)).toEqual({
      name: "accounts/1/locations/2/reviews/r1",
      stars: 2,
      reviewer: "Aoife M.",
      text: "Waited forty minutes.",
      created_at: "2026-10-30T10:00:00.000Z",
    });
  });

  it("an anonymous reviewer has no name; an unspecified rating has no stars; a bad name is no review", () => {
    expect(readReview({ ...base, reviewer: { isAnonymous: true } })?.reviewer).toBeNull();
    expect(readReview({ ...base, starRating: "STAR_RATING_UNSPECIFIED" })?.stars).toBeNull();
    expect(readReview({ ...base, name: "accounts/1/locations/2/reviews/r1/reply" })).toBeNull();
    expect(readReview({ ...base, createTime: "soon" })).toBeNull();
  });
});
