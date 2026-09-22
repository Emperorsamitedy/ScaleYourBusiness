// Fetching the owner's site — Phase 3 Session F. GET only, ever: this
// module is on the MEASUREMENT side of the fence (reading a public
// page), and the only writes in Session F go through the execution
// engine's registered providers.
//
// The URL comes from the owner, but the server doing the fetching
// lives inside infrastructure — so this is an SSRF surface and is
// guarded like one: http(s) only, no credentials in the URL, and the
// resolved address must be public. Loopback, RFC-1918, link-local and
// unique-local ranges are refused BY RESOLVED IP, not by hostname
// string, so "http://localtest.me" doesn't slip past. A redirect gets
// the same treatment per hop.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SiteFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "SiteFetchError";
    this.status = status;
  }
}

const MAX_BYTES = 1_500_000; // a marketing page, not a data dump
const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 15_000;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function privateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fe80") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:192.168.")
  );
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SiteFetchError("only http(s) sites can be read");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SiteFetchError("credentials don't belong in a site URL");
  }
  const host = url.hostname;
  const addresses: string[] = [];
  if (isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const results = await lookup(host, { all: true });
      for (const r of results) addresses.push(r.address);
    } catch {
      throw new SiteFetchError(`"${host}" doesn't resolve — is the address right?`);
    }
  }
  for (const address of addresses) {
    if (
      (isIP(address) === 4 && privateV4(address)) ||
      (isIP(address) === 6 && privateV6(address))
    ) {
      throw new SiteFetchError(
        "that address points inside a private network — refusing to fetch it",
      );
    }
  }
}

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  /** Wall-clock, for the load-regression baseline (P3-33). */
  duration_ms: number;
}

/** The seam: tests and the fixture site inject their own. */
export type PageFetcher = (url: string) => Promise<FetchedPage>;

export const livePageFetcher: PageFetcher = async (rawUrl) => {
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new SiteFetchError("that doesn't look like a web address");
  }

  const started = Date.now();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "Ledgerline-SiteRead/1.0 (owner-requested)" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) {
        throw new SiteFetchError("too many redirects — the site never settled");
      }
      current = new URL(location, current);
      continue;
    }
    const reader = response.body?.getReader();
    let html = "";
    let bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        html += decoder.decode(value, { stream: true });
      }
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      url: current.toString(),
      status: response.status,
      html,
      headers,
      duration_ms: Date.now() - started,
    };
  }
  throw new SiteFetchError("too many redirects — the site never settled");
};
