// A recorded-shape Google Analytics 4, for tests only (P2-18).
//
// Implements the three endpoints the connector calls, with Google's
// documented behaviour, and checks what matters: the token endpoint
// VERIFIES the JWT's RS256 signature against the service account's public
// key and records the scope it asked for; tokeninfo reports that scope;
// runReport answers only for the property the service account can view,
// groups rows by the requested dimensions, returns dates as YYYYMMDD, and
// pages with limit/offset/rowCount. Nothing in app code imports this file.

import { createVerify, generateKeyPairSync } from "node:crypto";
import type { Ga4Fetch, Ga4RequestInit, Ga4Response } from "./ga4";

export interface FakeServiceAccount {
  email: string;
  publicKey: string;
  /** The key file's contents, as an owner would paste them. */
  json: string;
}

export function makeServiceAccount(
  email = "ledgerline-reader@ember-oak.iam.gserviceaccount.com",
  tokenUri = "https://oauth2.googleapis.com/token",
): FakeServiceAccount {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    email,
    publicKey,
    json: JSON.stringify({
      type: "service_account",
      project_id: "ember-oak",
      private_key_id: "fake-key-id",
      private_key: privateKey,
      client_email: email,
      token_uri: tokenUri,
    }),
  };
}

export interface FakeGa4Row {
  date: string;
  channel: string;
  sessions: number;
  /** P2-29: the hour (0–23) in the property's zone. */
  hour?: number;
  /** P2-34: the landing page, and how many of these sessions bounced. */
  landing?: string;
  bounces?: number;
  /** P2-34: a site-search term and how many view_search_results events carried it. */
  searchTerm?: string;
  searches?: number;
}

export interface FakeGa4Call {
  url: URL;
  init: Ga4RequestInit;
  /** Decoded JWT claims, for calls to the token endpoint. */
  claims: Record<string, unknown> | null;
}

export interface FakeGa4Options {
  account: FakeServiceAccount;
  propertyId: string;
  rows?: FakeGa4Row[];
  /** Override what tokeninfo reports, to simulate a broader token. */
  reportedScope?: string;
  /** Can the service account view the property? Default true. */
  viewer?: boolean;
  /** The server's own page cap, to exercise offset paging. */
  maxRows?: number;
  /** The property's reporting zone, returned in metadata.timeZone. Default Europe/Budapest. */
  timeZone?: string | null;
  respond?: (call: FakeGa4Call, n: number) => Ga4Response | null;
}

export interface FakeGa4 {
  fetch: Ga4Fetch;
  calls: FakeGa4Call[];
  rows: FakeGa4Row[];
}

export function ga4Json(status: number, body: unknown): Ga4Response {
  return { status, json: async () => body };
}

export function fakeGa4(options: FakeGa4Options): FakeGa4 {
  const rows = options.rows ?? [];
  const calls: FakeGa4Call[] = [];
  const issued = new Map<string, string>(); // token → scope it was issued for
  let counter = 0;

  const fetch: Ga4Fetch = async (url, init) => {
    const u = new URL(url);
    let claims: Record<string, unknown> | null = null;

    if (u.origin + u.pathname === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(init.body ?? "").get("assertion") ?? "";
      const [header, payload] = assertion.split(".");
      if (header && payload) {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
      }
    }
    const call: FakeGa4Call = { url: u, init, claims };
    calls.push(call);
    const forced = options.respond?.(call, calls.length) ?? null;
    if (forced !== null) return forced;

    if (u.origin + u.pathname === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(init.body ?? "");
      const assertion = form.get("assertion") ?? "";
      const [header, payload, signature] = assertion.split(".");
      const valid =
        form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
        header !== undefined &&
        payload !== undefined &&
        signature !== undefined &&
        createVerify("RSA-SHA256")
          .update(`${header}.${payload}`)
          .verify(options.account.publicKey, signature, "base64url") &&
        claims?.["iss"] === options.account.email &&
        claims?.["aud"] === "https://oauth2.googleapis.com/token" &&
        Number(claims?.["exp"]) - Number(claims?.["iat"]) <= 3600;
      if (!valid) return ga4Json(400, { error: "invalid_grant", error_description: "Invalid JWT" });
      counter += 1;
      const token = `ya29.fake-${counter}`;
      issued.set(token, String(claims?.["scope"] ?? ""));
      return ga4Json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }

    if (u.origin + u.pathname === "https://oauth2.googleapis.com/tokeninfo") {
      const token = (init.headers["authorization"] ?? "").replace(/^Bearer /, "");
      const scope = issued.get(token);
      if (scope === undefined) return ga4Json(400, { error: "invalid_token" });
      return ga4Json(200, {
        azp: "1234567890",
        aud: "1234567890",
        scope: options.reportedScope ?? scope,
        expires_in: "3500",
      });
    }

    const reportPath = `/v1beta/properties/${options.propertyId}:runReport`;
    if (u.origin === "https://analyticsdata.googleapis.com") {
      const token = (init.headers["authorization"] ?? "").replace(/^Bearer /, "");
      if (!issued.has(token)) {
        return ga4Json(401, { error: { code: 401, message: "Request had invalid credentials." } });
      }
      if (u.pathname !== reportPath || options.viewer === false) {
        return ga4Json(403, {
          error: {
            code: 403,
            message: "User does not have sufficient permissions for this property.",
            status: "PERMISSION_DENIED",
          },
        });
      }
      const body = JSON.parse(init.body ?? "{}") as {
        dateRanges: { startDate: string; endDate: string }[];
        dimensions: { name: string }[];
        metrics: { name: string }[];
        limit: number;
        offset: number;
        dimensionFilter?: { filter?: { fieldName?: string; stringFilter?: { value?: string } } };
      };
      const range = body.dateRanges[0];
      const dims = body.dimensions.map((d) => d.name);
      const metrics = body.metrics.map((m) => m.name);
      const searchOnly =
        body.dimensionFilter?.filter?.stringFilter?.value === "view_search_results";
      const grouped = new Map<
        string,
        { dimensions: string[]; sessions: number; bounces: number; events: number }
      >();
      for (const row of rows) {
        if (!range || row.date < range.startDate || row.date > range.endDate) continue;
        if (searchOnly && !row.searchTerm) continue;
        if (dims.includes("dateHour") && row.hour === undefined) continue;
        const values = dims.map((d) =>
          d === "date"
            ? row.date.replace(/-/g, "")
            : d === "dateHour"
              ? `${row.date.replace(/-/g, "")}${String(row.hour).padStart(2, "0")}`
              : d === "sessionDefaultChannelGroup"
                ? row.channel
                : d === "landingPage"
                  ? (row.landing ?? "(not set)")
                  : d === "searchTerm"
                    ? (row.searchTerm ?? "(not set)")
                    : "",
        );
        const key = values.join("|");
        const current = grouped.get(key) ?? {
          dimensions: values,
          sessions: 0,
          bounces: 0,
          events: 0,
        };
        current.sessions += row.sessions;
        current.bounces += row.bounces ?? 0;
        current.events += row.searches ?? 0;
        grouped.set(key, current);
      }
      const metricValue = (m: string, r: { sessions: number; bounces: number; events: number }) =>
        m === "bounceRate"
          ? String(r.sessions > 0 ? r.bounces / r.sessions : 0)
          : m === "eventCount"
            ? String(r.events)
            : String(r.sessions);
      const all = [...grouped.values()].sort((a, b) =>
        a.dimensions.join("|") < b.dimensions.join("|") ? -1 : 1,
      );
      const limit = Math.min(body.limit, options.maxRows ?? body.limit);
      const page = all.slice(body.offset, body.offset + limit);
      const zone = options.timeZone === undefined ? "Europe/Budapest" : options.timeZone;
      return ga4Json(200, {
        dimensionHeaders: dims.map((name) => ({ name })),
        metricHeaders: metrics.map((name) => ({
          name,
          type: name === "bounceRate" ? "TYPE_FLOAT" : "TYPE_INTEGER",
        })),
        ...(page.length > 0
          ? {
              rows: page.map((r) => ({
                dimensionValues: r.dimensions.map((value) => ({ value })),
                metricValues: metrics.map((m) => ({ value: metricValue(m, r) })),
              })),
            }
          : {}),
        rowCount: all.length,
        ...(zone ? { metadata: { timeZone: zone, currencyCode: "EUR" } } : {}),
        kind: "analyticsData#runReport",
      });
    }

    return ga4Json(404, { error: { code: 404, message: "Not Found" } });
  };

  return { fetch, calls, rows };
}
