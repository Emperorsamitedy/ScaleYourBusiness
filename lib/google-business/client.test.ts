// I-45a — the fence, as a build gate. Google's one Business Profile scope can
// write. Until 2026-11-16 SYB's client could only read; the owner then lifted
// I-45a ("Google review replies + hours"), and exactly three writes joined the
// list. Four holds, each with a planted case that must fail:
//
//   1. The endpoint list is exactly these: the reads, Google's OAuth token
//      endpoint, a review's reply (PUT, DELETE) and the location's regular
//      hours (PATCH with updateMask=regularHours and nothing else). Anchored
//      patterns: no extra segment matches.
//   2. gbpRequest refuses, before fetch, any request not on the list or not
//      sent with its endpoint's method.
//   3. The source: in lib/google-business, PUT, PATCH and DELETE appear in
//      code only on their endpoint lines (and the method type), POST only on
//      the token endpoint's line, and nothing calls fetch except through
//      gbpRequest. Nowhere else in the app talks to the Business Profile APIs.
//   4. The three write helpers are called from one file only: the executor,
//      lib/execution/providers/google-business.ts, which runs inside the
//      engine after a recorded approval.
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
  it("is exactly these: the reads, the OAuth token exchange, and three writes", () => {
    const shape = Object.fromEntries(
      Object.entries(GBP_ENDPOINTS).map(([id, e]) => [
        id,
        `${e.method} ${e.origin} ${e.path.source.replace(/\\\//g, "/")}`,
      ]),
    );
    const REVIEW = "^/v4/accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/reviews/[A-Za-z0-9_-]+";
    expect(shape).toEqual({
      token: "POST https://oauth2.googleapis.com ^/token$",
      accounts: "GET https://mybusinessaccountmanagement.googleapis.com ^/v1/accounts$",
      locations:
        "GET https://mybusinessbusinessinformation.googleapis.com ^/v1/accounts/[A-Za-z0-9_-]+/locations$",
      reviews:
        "GET https://mybusiness.googleapis.com ^/v4/accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/reviews$",
      review: `GET https://mybusiness.googleapis.com ${REVIEW}$`,
      location:
        "GET https://mybusinessbusinessinformation.googleapis.com ^/v1/locations/[A-Za-z0-9_-]+$",
      reply_put: `PUT https://mybusiness.googleapis.com ${REVIEW}/reply$`,
      reply_delete: `DELETE https://mybusiness.googleapis.com ${REVIEW}/reply$`,
      hours_patch:
        "PATCH https://mybusinessbusinessinformation.googleapis.com ^/v1/locations/[A-Za-z0-9_-]+$",
    });
    expect(GBP_SCOPE).toBe("https://www.googleapis.com/auth/business.manage");
  });

  it("I-45a lifted: allows the reply's PUT and DELETE, and a PATCH of regularHours only", () => {
    const reply = `${REVIEWS}/333/reply`;
    const loc = "https://mybusinessbusinessinformation.googleapis.com/v1/locations/222";
    expect(allowedEndpoint("PUT", reply)).toBe("reply_put");
    expect(allowedEndpoint("DELETE", reply)).toBe("reply_delete");
    expect(allowedEndpoint("GET", `${REVIEWS}/333`)).toBe("review");
    expect(allowedEndpoint("GET", `${loc}?readMask=regularHours`)).toBe("location");
    expect(allowedEndpoint("PATCH", `${loc}?updateMask=regularHours`)).toBe("hours_patch");
    expect(allowedEndpoint("PATCH", `${loc}?updateMask=regularHours&validateOnly=true`)).toBe(
      "hours_patch",
    );
  });

  it("I-45a lifted: every other listing write stays refused, planted deliberately", () => {
    const loc = "https://mybusinessbusinessinformation.googleapis.com/v1/locations/222";
    // Any other field of the listing — its name, phone, address, categories.
    expect(allowedEndpoint("PATCH", `${loc}?updateMask=title`)).toBeNull();
    expect(allowedEndpoint("PATCH", `${loc}?updateMask=regularHours,phoneNumbers`)).toBeNull();
    expect(allowedEndpoint("PATCH", `${loc}?updateMask=specialHours`)).toBeNull();
    expect(allowedEndpoint("PATCH", loc)).toBeNull();
    expect(allowedEndpoint("PATCH", `${loc}?validateOnly=true&updateMask=regularHours`)).toBeNull();
    // Deleting the location, or writing the review itself.
    expect(allowedEndpoint("DELETE", loc)).toBeNull();
    expect(allowedEndpoint("PUT", `${REVIEWS}/333`)).toBeNull();
    expect(allowedEndpoint("DELETE", `${REVIEWS}/333`)).toBeNull();
    expect(allowedEndpoint("PATCH", `${REVIEWS}/333/reply`)).toBeNull();
    expect(allowedEndpoint("POST", `${REVIEWS}/333/reply`)).toBeNull();
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

  it("refuses every other request, planted deliberately", () => {
    const reply = `${REVIEWS}/333/reply`;
    expect(allowedEndpoint("GET", reply)).toBeNull();
    expect(allowedEndpoint("POST", REVIEWS)).toBeNull();
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
    expect(
      allowedEndpoint(
        "PUT",
        "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/3/reply/x",
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
    // A reply's PUT sent to the review itself, a delete with a body, a PATCH of another field.
    await expect(gbpRequest("reply_put", `${REVIEWS}/333`, {}, spy)).rejects.toMatchObject({
      kind: "fence",
    });
    await expect(
      gbpRequest("reply_delete", `${REVIEWS}/333/reply`, { body: "{}" }, spy),
    ).rejects.toMatchObject({ kind: "fence" });
    await expect(
      gbpRequest(
        "hours_patch",
        "https://mybusinessbusinessinformation.googleapis.com/v1/locations/2?updateMask=title",
        { body: "{}" },
        spy,
      ),
    ).rejects.toMatchObject({ kind: "fence" });
    expect(seen).toEqual([]);
  });

  it("a write is sent once with its own verb, never retried here", async () => {
    const busy = fakeGoogle({ writeStatus: 503 });
    await expect(
      gbpRequest("reply_put", `${REVIEWS}/333/reply`, { body: "{}" }, busy.fetch),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(busy.requests).toEqual([{ method: "PUT", url: `${REVIEWS}/333/reply` }]);
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

/** The code lines that may name a write verb: the method type and the three endpoints. */
const VERB_LINES = new Set([
  'export type GbpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";',
  'method: "PUT",',
  'method: "DELETE",',
  'method: "PATCH",',
]);

/** Pure: what in this source breaks the fence. */
export function fenceBreaks(text: string): string[] {
  const out: string[] = [];
  for (const line of codeLines(text)) {
    if (/\b(PUT|PATCH|DELETE)\b/.test(line) && !VERB_LINES.has(line)) out.push(`verb: ${line}`);
    if (
      /\bPOST\b/.test(line) &&
      !line.startsWith('token: { method: "POST", origin: "https://oauth2.googleapis.com"') &&
      !line.startsWith("export type GbpMethod")
    )
      out.push(`post: ${line}`);
    if (/\bfetch\s*\(/.test(line)) out.push(`fetch: ${line}`);
  }
  return out;
}

describe("I-45a — the source holds the fence (THE BUILD GATE)", () => {
  it("no file in lib/google-business names a write verb but on the endpoint list", () => {
    const files = sources(DIR);
    expect(files.map((f) => f.file)).toContain("client.ts");
    const breaks = files.flatMap((f) => fenceBreaks(f.text).map((b) => `${f.file}: ${b}`));
    expect(breaks).toEqual([]);
    // Each write verb is on exactly one endpoint line, all in client.ts.
    const client = codeLines(files.find((f) => f.file === "client.ts")!.text);
    for (const verb of ["PUT", "DELETE", "PATCH"]) {
      expect(client.filter((l) => l === `method: "${verb}",`)).toHaveLength(1);
    }
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

  it("I-45a lifted: the three writes are called from the executor alone", () => {
    const EXECUTOR = path.resolve(process.cwd(), "lib/execution/providers/google-business.ts");
    const CLIENT = path.join(DIR, "client.ts");
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && full !== CLIENT) {
          const code = codeLines(readFileSync(full, "utf8")).join("\n");
          if (/\b(putReviewReply|deleteReviewReply|patchRegularHours)\s*\(/.test(code))
            callers.push(path.relative(process.cwd(), full).replace(/\\/g, "/"));
        }
      }
    };
    for (const top of ["app", "lib", "components", "scripts"])
      walk(path.resolve(process.cwd(), top));
    expect(callers).toEqual([path.relative(process.cwd(), EXECUTOR).replace(/\\/g, "/")]);
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
