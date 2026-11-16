// A recorded-shape stand-in for Google's token endpoint and the Business
// Profile read APIs — I-45a. Tests and nothing else: no network. The shapes
// follow Google's reference pages as read on 2026-11-01 (see ./client.ts);
// no real response was captured, because SYB has no approved API access yet.
//
// It answers only the endpoints SYB may call, records every request it is
// sent (method and URL, never a body), and refuses anything else with a 405,
// so a test can tell a request that should never have been made. Since I-45a
// was lifted (2026-11-16) it also holds a reply per review and the location's
// regular hours, and answers the three writes on them: a PUT or DELETE of a
// reply, and a regularHours PATCH (validateOnly answered empty, unchanged).

import { GBP_SCOPE } from "./client";

export interface FakeReview {
  id: string;
  stars: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "STAR_RATING_UNSPECIFIED";
  reviewer: string | null;
  comment: string | null;
  createTime: string;
}

export interface FakeLocation {
  account: string;
  id: string;
  title: string;
  mapsUri?: string;
}

export interface FakeGoogleOptions {
  /** What the token endpoint says was granted. Default: exactly business.manage. */
  scope?: string;
  /** Whether the code exchange returns a refresh token. Default true. */
  refreshToken?: boolean;
  locations?: FakeLocation[];
  /** Reviews per "accounts/{a}/locations/{l}", newest update first. */
  reviews?: Record<string, FakeReview[]>;
  /** An HTTP status every reviews read answers with instead. */
  reviewsStatus?: number;
  /** The refresh answers invalid_grant: the owner revoked SYB at Google. */
  revoked?: boolean;
  pageSize?: number;
  /** Replies by review name ("accounts/a/locations/l/reviews/r"). Mutated by the writes. */
  replies?: Record<string, string>;
  /** Regular hours periods by location name ("locations/l"). Mutated by the writes. */
  hours?: Record<string, unknown[]>;
  /** An HTTP status every write answers with instead (a validateOnly patch too). */
  writeStatus?: number;
}

export interface FakeGoogle {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  requests: { method: string; url: string }[];
  replies: Record<string, string>;
  hours: Record<string, unknown[]>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeGoogle(opts: FakeGoogleOptions = {}): FakeGoogle {
  const requests: { method: string; url: string }[] = [];
  const locations = opts.locations ?? [
    {
      account: "accounts/111",
      id: "locations/222",
      title: "Lumen Hair Studio",
      mapsUri: "https://maps.google.com/maps?cid=1234",
    },
  ];
  const size = opts.pageSize ?? 50;
  const replies: Record<string, string> = { ...(opts.replies ?? {}) };
  const hours: Record<string, unknown[]> = { ...(opts.hours ?? {}) };
  const fetchFake = async (input: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(input);
    requests.push({ method, url: u.toString() });
    const reply = /^\/v4\/(accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+)\/reply$/.exec(
      u.pathname,
    );
    if (u.origin === "https://mybusiness.googleapis.com" && reply) {
      if (opts.writeStatus) return json(opts.writeStatus, { error: { code: opts.writeStatus } });
      const key = reply[1] as string;
      if (method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}")) as { comment?: string };
        replies[key] = String(body.comment ?? "");
        return json(200, { comment: replies[key], updateTime: "2026-11-16T10:00:00Z" });
      }
      if (method === "DELETE") {
        delete replies[key];
        return json(200, {});
      }
      return json(405, { error: { code: 405 } });
    }
    const oneReview = /^\/v4\/(accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+)$/.exec(
      u.pathname,
    );
    if (u.origin === "https://mybusiness.googleapis.com" && oneReview && method === "GET") {
      const key = oneReview[1] as string;
      return json(200, {
        name: key,
        starRating: "TWO",
        createTime: "2026-11-01T10:00:00Z",
        ...(key in replies ? { reviewReply: { comment: replies[key] } } : {}),
      });
    }
    const oneLocation = /^\/v1\/(locations\/[^/]+)$/.exec(u.pathname);
    if (u.origin === "https://mybusinessbusinessinformation.googleapis.com" && oneLocation) {
      const key = oneLocation[1] as string;
      if (method === "GET") {
        if (u.searchParams.get("readMask") !== "regularHours") {
          return json(400, { error: { code: 400, status: "INVALID_ARGUMENT" } });
        }
        return json(200, key in hours ? { regularHours: { periods: hours[key] } } : {});
      }
      if (method === "PATCH") {
        if (opts.writeStatus) return json(opts.writeStatus, { error: { code: opts.writeStatus } });
        if (u.searchParams.get("updateMask") !== "regularHours") {
          return json(400, { error: { code: 400, status: "INVALID_ARGUMENT" } });
        }
        if (u.searchParams.get("validateOnly") === "true") return new Response("", { status: 200 });
        const body = JSON.parse(String(init.body ?? "{}")) as {
          regularHours?: { periods?: unknown[] };
        };
        hours[key] = body.regularHours?.periods ?? [];
        return json(200, { name: key, regularHours: { periods: hours[key] } });
      }
    }
    if (
      method === "POST" &&
      u.origin === "https://oauth2.googleapis.com" &&
      u.pathname === "/token"
    ) {
      const body = new URLSearchParams(String(init.body ?? ""));
      const grant = body.get("grant_type");
      if (grant === "refresh_token" && opts.revoked) {
        return json(400, { error: "invalid_grant", error_description: "Token has been revoked." });
      }
      if (grant !== "authorization_code" && grant !== "refresh_token") {
        return json(400, { error: "unsupported_grant_type" });
      }
      if (grant === "authorization_code" && !body.get("code_verifier")) {
        return json(400, { error: "invalid_grant", error_description: "Missing code verifier." });
      }
      return json(200, {
        access_token: "ya29.fake-access",
        expires_in: 3599,
        token_type: "Bearer",
        scope: opts.scope ?? GBP_SCOPE,
        ...(grant === "authorization_code" && opts.refreshToken !== false
          ? { refresh_token: "1//fake-refresh" }
          : {}),
      });
    }
    if (method !== "GET") return json(405, { error: { code: 405, status: "METHOD_NOT_ALLOWED" } });
    if (
      u.origin === "https://mybusinessaccountmanagement.googleapis.com" &&
      u.pathname === "/v1/accounts"
    ) {
      const names = [...new Set(locations.map((l) => l.account))];
      return json(200, {
        accounts: names.map((name) => ({ name, accountName: "Lumen", type: "PERSONAL" })),
      });
    }
    const loc = /^\/v1\/(accounts\/[^/]+)\/locations$/.exec(u.pathname);
    if (u.origin === "https://mybusinessbusinessinformation.googleapis.com" && loc) {
      if (!u.searchParams.get("readMask")) {
        return json(400, { error: { code: 400, status: "INVALID_ARGUMENT" } });
      }
      return json(200, {
        locations: locations
          .filter((l) => l.account === loc[1])
          .map((l) => ({
            name: l.id,
            title: l.title,
            ...(l.mapsUri ? { metadata: { mapsUri: l.mapsUri } } : {}),
          })),
      });
    }
    const rev = /^\/v4\/(accounts\/[^/]+\/locations\/[^/]+)\/reviews$/.exec(u.pathname);
    if (u.origin === "https://mybusiness.googleapis.com" && rev) {
      if (opts.reviewsStatus) {
        return json(opts.reviewsStatus, { error: { code: opts.reviewsStatus } });
      }
      const all = opts.reviews?.[rev[1] as string] ?? [];
      const start = Number(u.searchParams.get("pageToken") ?? "0");
      const slice = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return json(200, {
        reviews: slice.map((r) => ({
          name: `${rev[1]}/reviews/${r.id}`,
          reviewId: r.id,
          reviewer:
            r.reviewer === null
              ? { isAnonymous: true }
              : {
                  displayName: r.reviewer,
                  profilePhotoUrl: "https://lh3.googleusercontent.com/a/x",
                },
          starRating: r.stars,
          ...(r.comment !== null ? { comment: r.comment } : {}),
          createTime: r.createTime,
          updateTime: r.createTime,
        })),
        averageRating: 4.2,
        totalReviewCount: all.length,
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    return json(404, { error: { code: 404, status: "NOT_FOUND" } });
  };
  return { fetch: fetchFake, requests, replies, hours };
}
