// Fetching the owner's site — Phase 3 Session F. GET only, ever: this
// module is on the MEASUREMENT side of the fence (reading a public
// page), and the only writes in Session F go through the execution
// engine's registered providers.
//
// The URL comes from the owner, but the server doing the fetching
// lives inside infrastructure — so this is an SSRF surface and is
// guarded like one. Two properties, both born from the 2026-09-26
// security review's verified findings:
//
//   1. PRIVATE MEANS PRIVATE IN EVERY SPELLING. Refusal is by resolved
//      address, and an IPv6 address that merely WRAPS an IPv4 one
//      (::ffff:169.254.169.254, or its hex twin ::ffff:a9fe:a9fe) is
//      normalized to the embedded IPv4 and judged by the IPv4 rules —
//      the review showed the old prefix blocklist let the v4-mapped
//      form of the cloud metadata address straight through.
//
//   2. THE CHECK AND THE CONNECT SHARE ONE RESOLUTION. The old code
//      vetted dns.lookup's answer and then let fetch() resolve AGAIN —
//      a textbook rebinding TOCTOU (TTL-0 nameserver alternating
//      public/internal answers wins near-deterministically). Now every
//      hop resolves once, vets those exact addresses, and connects
//      through an undici Agent whose lookup returns ONLY the vetted
//      list. TLS SNI and certificate checks still run against the
//      hostname; only the TCP target is pinned.
//
// Happy-eyeballs stays on: a dual-stack site fetched from a host with
// no IPv6 route otherwise dies with a bare "fetch failed" — found live
// against example.com from this very box.

import { lookup } from "node:dns/promises";
import { isIP, setDefaultAutoSelectFamily } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

try {
  setDefaultAutoSelectFamily(true);
} catch {
  /* older Node without the switch — fetch behaves as before */
}

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
  if (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) return true; // CGNAT
  // Added by the security review of 2026-10-17:
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF special use (and 192.0.2/24 docs)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 documentation
  if (a === 203 && b === 0) return true; // 203.0.113/24 documentation
  if ((a ?? 0) >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false;
}

/**
 * An IPv6 address that embeds an IPv4 one (v4-mapped ::ffff:a.b.c.d,
 * its hex spelling ::ffff:xxxx:yyyy, or the deprecated v4-compatible
 * ::a.b.c.d) yields that IPv4; everything else yields null. The
 * embedded address must then face the IPv4 rules — this is the
 * review's finding 1.
 */
export function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted?.[1] && isIP(dotted[1]) === 4) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

function privateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    /^fe[89ab]/.test(lower) || // fe80::/10 link-local, the whole /10 (review 2026-10-17)
    /^fe[c-f]/.test(lower) || // fec0::/10 deprecated site-local
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("ff") || // ff00::/8 multicast
    lower.startsWith("64:ff9b:") || // NAT64: embeds an IPv4 the egress may route to
    lower.startsWith("2002:") // 6to4: embeds an IPv4 too
  );
}

/** The one judgement every resolved address faces, whatever its spelling. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return privateV4(ip);
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4 !== null) return privateV4(v4);
    return privateV6(ip);
  }
  return true; // not an IP at all — never connectable
}

interface VettedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve a URL's host ONCE and vet every address. The returned list is
 * what the connection is pinned to — the same resolution result serves
 * both the check and the connect (the review's finding 2).
 */
export async function vetAddresses(url: URL): Promise<VettedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SiteFetchError("only http(s) sites can be read");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SiteFetchError("credentials don't belong in a site URL");
  }
  // URL#hostname keeps brackets on IPv6 literals; strip for isIP.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses: VettedAddress[] = [];
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    addresses.push({ address: host, family: literalFamily as 4 | 6 });
  } else {
    try {
      const results = await lookup(host, { all: true });
      for (const r of results) addresses.push({ address: r.address, family: r.family as 4 | 6 });
    } catch {
      throw new SiteFetchError(`"${host}" doesn't resolve — is the address right?`);
    }
  }
  if (addresses.length === 0) {
    throw new SiteFetchError(`"${host}" doesn't resolve — is the address right?`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SiteFetchError(
        "that address points inside a private network — refusing to fetch it",
      );
    }
  }
  return addresses;
}

/**
 * A lookup function that answers ONLY from the vetted list — handed to
 * the connection layer so no second, unvetted resolution can occur.
 * Exported for its own tests.
 */
export function pinnedLookup(vetted: readonly VettedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && options.all === true;
    if (all) {
      (callback as (err: Error | null, addresses: { address: string; family: number }[]) => void)(
        null,
        vetted.map((v) => ({ address: v.address, family: v.family })),
      );
      return;
    }
    const first = vetted[0];
    if (!first) {
      callback(new Error("no vetted address to connect to"), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  };
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
    // Resolve once, vet, and pin the connection to exactly those
    // addresses. TLS still validates against the hostname.
    const vetted = await vetAddresses(current);
    const agent = new Agent({ connect: { lookup: pinnedLookup(vetted) } });
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(current, {
        dispatcher: agent,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "Ledgerline-SiteRead/1.0 (owner-requested)" },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === MAX_REDIRECTS) {
          throw new SiteFetchError("too many redirects — the site never settled");
        }
        current = new URL(location, current);
        continue; // the next hop gets its own resolve-vet-pin
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
    } finally {
      await agent.close();
    }
  }
  throw new SiteFetchError("too many redirects — the site never settled");
};
