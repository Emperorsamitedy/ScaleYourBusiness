// Session F — P3-30..35 as tests. The done-when clauses: a change
// previews from the real page, applies on approval through the
// engine, undoes with one click, a seeded hard failure auto-rolls-
// back while a "conversion dip" cannot even be expressed; plus both
// rule-18 walls at the generator, the SSRF guard, platform detection
// with the manual path, and apply-time drift honesty.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { undoExecution } from "../execution/engine";
import {
  fixtureSiteExecutor,
  fixtureSiteRead,
  fixtureSiteReset,
  fixtureSiteSet,
} from "../execution/providers/fixture-site";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import * as applyModule from "./apply";
import { HEALTH, applySiteChange, checkSiteHealth } from "./apply";
import { proposeSiteChange } from "./changes";
import type { FetchedPage, PageFetcher } from "./fetch";
import {
  embeddedV4,
  isPrivateAddress,
  livePageFetcher,
  pinnedLookup,
  standardWebPort,
  v6Groups,
} from "./fetch";
import { detectPlatform } from "./platform";

const created: { account_id: string; profile_id: string }[] = [];
const noLimits: LimitLlm = async () => ({ text: '{"limits": []}', calls: [] });
const noSleep = async () => undefined;

const SITE = "https://emberworks.example/about";

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-f-${crypto.randomUUID()}@test.local`,
      display_name: "Session F owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

/** A fetcher over the fixture site, with scriptable status/duration. */
function siteFetcher(
  overrides: { status?: number; duration_ms?: number; afterApply?: Partial<FetchedPage> } = {},
): PageFetcher {
  let calls = 0;
  return async (url: string) => {
    calls += 1;
    const base: FetchedPage = {
      url,
      status: overrides.status ?? 200,
      html: fixtureSiteRead(url) ?? "",
      headers: {},
      duration_ms: overrides.duration_ms ?? 50,
    };
    // Second-and-later calls are the post-apply health checks.
    if (calls > 1 && overrides.afterApply) return { ...base, ...overrides.afterApply };
    return base;
  };
}

const PAGE = (headline: string) =>
  `<!doctype html><html><head><title>Emberworks</title></head><body><header><h1>${headline}</h1></header><main><p>Candles that smell like a real fireplace.</p></main></body></html>`;

beforeEach(() => {
  fixtureSiteReset();
  fixtureSiteSet(SITE, PAGE("Old headline"));
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(inArray(executions.profile_id, ids));
    if (rows.length > 0)
      await db.delete(executionAttempts).where(
        inArray(
          executionAttempts.execution_id,
          rows.map((r) => r.id),
        ),
      );
    await db.delete(executions).where(inArray(executions.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-30 — platform detection", () => {
  it("names each platform from its markers, with the spec's editability", () => {
    const cases: [string, string, string][] = [
      ['<script src="https://cdn.shopify.com/x.js"></script>', "shopify", "api"],
      ['<link href="/wp-content/plugins/woocommerce/a.css">', "woocommerce", "api"],
      ['<link href="/wp-content/themes/twentytwenty/style.css">', "wordpress", "partial"],
      ['<script src="https://static.parastorage.com/x.js"></script>', "wix", "manual"],
      ['<script src="https://static1.squarespace.com/x.js"></script>', "squarespace", "manual"],
      ['<html data-wf-site="abc123">', "webflow", "partial"],
      ["<html><body>plain</body></html>", "custom", "unknown"],
    ];
    for (const [html, platform, editable] of cases) {
      const verdict = detectPlatform(html);
      expect(verdict.platform).toBe(platform);
      expect(verdict.editable).toBe(editable);
      expect(verdict.marker).not.toBe("");
    }
  });
});

describe("the SSRF guard", () => {
  it("refuses private targets, wrong schemes, and credentialed URLs", async () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "http://localhost:3000/",
      "http://192.168.1.1/",
      "http://10.0.0.5/x",
      "http://169.254.169.254/latest/meta-data",
      "ftp://example.com/",
      "https://user:pass@example.com/",
    ]) {
      await expect(livePageFetcher(url)).rejects.toThrow();
    }
  });

  it("finding 1: every spelling of a private address is private — mapped v6 included", () => {
    // The review's verified bypasses, now assertions forever.
    for (const ip of [
      "::ffff:169.254.169.254", // cloud metadata, dotted-mapped
      "::ffff:a9fe:a9fe", // cloud metadata, hex-mapped
      "::ffff:7f00:1", // loopback, hex-mapped
      "::ffff:127.0.0.1",
      "::ffff:172.16.0.1", // RFC-1918 172.16/12, dotted-mapped
      "::ffff:ac10:1", // same, hex-mapped
      "::ffff:10.0.0.5",
      "::ffff:0.0.0.0",
      "::127.0.0.1", // deprecated v4-compatible form
      "100.64.0.1", // CGNAT
      "::",
      "::1",
      "fe80::1",
      "fd00::1",
      "not-an-ip", // unresolvable spellings never connect
      // The 2026-10-17 security review's additions:
      "192.0.0.8", // IETF special use
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
      "febf::1", // the far end of fe80::/10
      "fec0::1", // site-local
      "ff02::1", // multicast
      "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
      "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("finding 20 (review 2026-10-23): ::/96 in any spelling is private, ::ffff:0:0/96 faces the IPv4 rules", async () => {
    // The URL parser rewrites [::127.0.0.1] as [::7f00:1]: the spelling that used to pass.
    expect(new URL("http://[::127.0.0.1]/").hostname).toBe("[::7f00:1]");
    for (const ip of [
      "::7f00:1",
      "::a00:1", // ::10.0.0.1
      "::808:808", // ::8.8.8.8 — v4-compatible is deprecated, so private whatever it wraps
      "0:0:0:0:0:0:127.0.0.1",
      "::ffff:a00:1", // ::ffff:10.0.0.1, as the URL parser spells it
      "::ffff:0:a00:1", // the translated form
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["::ffff:808:808", "2001:db8::7f00:1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(v6Groups("::7f00:1")).toEqual([0, 0, 0, 0, 0, 0, 0x7f00, 1]);
    expect(v6Groups("not-an-ip")).toBeNull();
    // Refused before any connection is tried.
    for (const url of [
      "http://[::127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "https://[::7f00:1]:443/",
    ]) {
      await expect(livePageFetcher(url)).rejects.toThrow(/private network/);
    }
  });

  it("finding 20: only ports 80 and 443, on every hop", async () => {
    expect(standardWebPort(new URL("https://example.com/"))).toBe(true);
    expect(standardWebPort(new URL("http://example.com:80/"))).toBe(true);
    expect(standardWebPort(new URL("http://example.com:443/"))).toBe(true);
    expect(standardWebPort(new URL("https://example.com:8080/"))).toBe(false);
    expect(standardWebPort(new URL("http://example.com:6379/"))).toBe(false);
    await expect(livePageFetcher("https://example.com:8080/")).rejects.toThrow(/ports 80 and 443/);
  });

  it("embeddedV4 unwraps both spellings and nothing else", () => {
    expect(embeddedV4("::ffff:169.254.169.254")).toBe("169.254.169.254");
    expect(embeddedV4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedV4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedV4("2606:4700::1111")).toBeNull();
    expect(embeddedV4("::1")).toBeNull();
  });

  it("finding 2: the pinned lookup answers ONLY from the vetted list — no second resolution", async () => {
    const vetted = [{ address: "93.184.216.34", family: 4 as const }];
    const lookupFn = pinnedLookup(vetted);
    // Whatever hostname the connection layer asks about, the answer is
    // the vetted address — a rebinding nameserver never gets a second question.
    const single = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookupFn("rebind.attacker.example", { family: 0 }, (err, address, family) =>
        err ? reject(err) : resolve({ address: address as string, family: family as number }),
      );
    });
    expect(single).toEqual({ address: "93.184.216.34", family: 4 });
    const all = await new Promise<unknown>((resolve, reject) => {
      (lookupFn as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)(
        "rebind.attacker.example",
        { all: true },
        (err, addresses) => (err ? reject(err) : resolve(addresses)),
      );
    });
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
    // An empty vetted list refuses to connect rather than resolving fresh.
    const empty = pinnedLookup([]);
    await expect(
      new Promise((resolve, reject) =>
        empty("x.example", { family: 0 }, (err, a) => (err ? reject(err) : resolve(a))),
      ),
    ).rejects.toThrow(/no vetted address/);
  });
});

describe("P3-34 — rule 18 at the generator, both walls", () => {
  it("wall one: a money-surface URL is refused BEFORE any fetch", async () => {
    const s = await fresh();
    const neverCalled: PageFetcher = async () => {
      throw new Error("fetched a checkout page — the wall failed");
    };
    for (const url of [
      "https://shop.example/checkout",
      "https://shop.example/cart?step=2",
      "https://shop.example/billing/",
      "https://shop.example/payment#top",
    ]) {
      await expect(
        proposeSiteChange(s.profile_id, {
          url,
          find: "a",
          replace: "b",
          fetcher: neverCalled,
          limitLlm: noLimits,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("wall two: a target inside a payment area cannot even be proposed", async () => {
    const s = await fresh();
    fixtureSiteSet(
      SITE,
      `<html><body><form action="/api/stripe-session"><label>Card number</label><p>Fast dispatch</p></form></body></html>`,
    );
    await expect(
      proposeSiteChange(s.profile_id, {
        url: SITE,
        find: "Fast dispatch",
        replace: "Same-day dispatch",
        fetcher: siteFetcher(),
        limitLlm: noLimits,
      }),
    ).rejects.toThrow(/money surfaces are untouchable/);
    const rows = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.profile_id, s.profile_id));
    expect(rows).toHaveLength(0); // cannot even be PROPOSED
  });
});

describe("P3-31 — the proposal and its previews", () => {
  it("previews the real before and after, records the baseline, demands a unique match", async () => {
    const s = await fresh();
    const proposal = await proposeSiteChange(s.profile_id, {
      url: SITE,
      find: "Old headline",
      replace: "Candles with a fireplace soul",
      fetcher: siteFetcher({ duration_ms: 120 }),
      limitLlm: noLimits,
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.module).toBe("site");
    const detail = (
      proposal.action as {
        detail: {
          site_preview: { before_html: string; after_html: string };
          health_baseline_ms: number;
        };
      }
    ).detail;
    expect(detail.site_preview.before_html).toContain("Old headline");
    expect(detail.site_preview.after_html).toContain("Candles with a fireplace soul");
    expect(detail.site_preview.after_html).not.toContain("Old headline");
    expect(detail.health_baseline_ms).toBe(120);

    await expect(
      proposeSiteChange(s.profile_id, {
        url: SITE,
        find: "nowhere-text",
        replace: "x",
        fetcher: siteFetcher(),
        limitLlm: noLimits,
      }),
    ).rejects.toThrow(/can't find/);

    fixtureSiteSet(SITE, PAGE("Twice Twice"));
    await expect(
      proposeSiteChange(s.profile_id, {
        url: SITE,
        find: "Twice",
        replace: "Once",
        fetcher: siteFetcher(),
        limitLlm: noLimits,
      }),
    ).rejects.toThrow(/appears 2 times/);
  });
});

describe("P3-31/32 — apply through the engine, undo months later", () => {
  it("the full loop: approve → apply → live page changed → one-click undo restores byte for byte", async () => {
    const s = await fresh();
    const original = fixtureSiteRead(SITE) as string;
    const proposal = await proposeSiteChange(s.profile_id, {
      url: SITE,
      find: "Old headline",
      replace: "New headline",
      fetcher: siteFetcher(),
      limitLlm: noLimits,
    });
    await approveProposal({ proposalId: proposal.id, userId: s.user_id });

    const outcome = await applySiteChange({
      proposalId: proposal.id,
      fetcher: siteFetcher(),
      sleep: noSleep,
    });
    expect(outcome.rolled_back).toBe(false);
    expect(outcome.health.ok).toBe(true);
    expect(fixtureSiteRead(SITE)).toContain("New headline");

    const undone = await undoExecution({
      executionId: outcome.execution.id,
      provider: fixtureSiteExecutor,
      userId: s.user_id,
    });
    expect(undone.status).toBe("undone");
    expect(fixtureSiteRead(SITE)).toBe(original); // byte for byte
  });

  it("apply-time drift refuses a stale diff — the page changed since approval", async () => {
    const s = await fresh();
    const proposal = await proposeSiteChange(s.profile_id, {
      url: SITE,
      find: "Old headline",
      replace: "New headline",
      fetcher: siteFetcher(),
      limitLlm: noLimits,
    });
    await approveProposal({ proposalId: proposal.id, userId: s.user_id });
    fixtureSiteSet(SITE, PAGE("Somebody else edited this"));
    await expect(
      applySiteChange({ proposalId: proposal.id, fetcher: siteFetcher(), sleep: noSleep }),
    ).rejects.toThrow(/changed since you approved/);
    expect(fixtureSiteRead(SITE)).toContain("Somebody else edited this"); // untouched
  });
});

describe("P3-33 — auto-rollback on hard failures ONLY", () => {
  it("a seeded 500 after apply rolls back automatically, as the system, on the record", async () => {
    const s = await fresh();
    const original = fixtureSiteRead(SITE) as string;
    const proposal = await proposeSiteChange(s.profile_id, {
      url: SITE,
      find: "Old headline",
      replace: "New headline",
      fetcher: siteFetcher(),
      limitLlm: noLimits,
    });
    await approveProposal({ proposalId: proposal.id, userId: s.user_id });

    const outcome = await applySiteChange({
      proposalId: proposal.id,
      fetcher: siteFetcher({ afterApply: { status: 500 } }),
      sleep: noSleep,
    });
    expect(outcome.rolled_back).toBe(true);
    expect(outcome.health.reasons.join(" ")).toContain("500");
    expect(outcome.execution.status).toBe("undone");
    expect(outcome.execution.undone_by).toBeNull(); // the system, not a person
    expect(fixtureSiteRead(SITE)).toBe(original);
  });

  it("load-regression thresholds bite at the boundary, both directions", async () => {
    const flat =
      (duration: number, status = 200): PageFetcher =>
      async (url) => ({
        url,
        status,
        html: PAGE("x"),
        headers: {},
        duration_ms: duration,
      });
    // baseline 1000 → threshold max(3000, 3000) = 3000
    expect((await checkSiteHealth(SITE, 1000, flat(3000))).ok).toBe(true);
    expect((await checkSiteHealth(SITE, 1000, flat(3001))).ok).toBe(false);
    // baseline 100 → the floor rules: max(300, 2100) = 2100
    expect((await checkSiteHealth(SITE, 100, flat(2100))).ok).toBe(true);
    expect((await checkSiteHealth(SITE, 100, flat(2101))).ok).toBe(false);
    // a 499 is not a server error; a 500 is
    expect((await checkSiteHealth(SITE, 1000, flat(100, 499))).ok).toBe(true);
    expect((await checkSiteHealth(SITE, 1000, flat(100, 500))).ok).toBe(false);
    expect(HEALTH.load_factor).toBe(3);
  });

  it("conversion noise is structurally unable to trigger a rollback — nothing here can even express it", () => {
    for (const name of Object.keys(applyModule)) {
      expect(name).not.toMatch(/conversion|revenue|sales|orders/i);
    }
    // The health report's whole vocabulary:
    const reportKeys = ["ok", "reasons", "status", "duration_ms", "threshold_ms"];
    expect(reportKeys.join(",")).not.toMatch(/conversion/);
  });
});

describe("P3-35 — the manual path for Wix and Squarespace", () => {
  it("a Wix page proposes with instructions, and apply refuses honestly", async () => {
    const s = await fresh();
    fixtureSiteSet(
      SITE,
      `<html><head><script src="https://static.parastorage.com/services/x.js"></script></head><body><h1>Old headline</h1></body></html>`,
    );
    const proposal = await proposeSiteChange(s.profile_id, {
      url: SITE,
      find: "Old headline",
      replace: "New headline",
      fetcher: siteFetcher(),
      limitLlm: noLimits,
    });
    const detail = (
      proposal.action as {
        detail: { manual_instructions: string[] | null; platform: { platform: string } };
      }
    ).detail;
    expect(detail.platform.platform).toBe("wix");
    expect(detail.manual_instructions).not.toBeNull();
    expect(detail.manual_instructions?.join(" ")).toContain("Wix editor");
    expect(detail.manual_instructions?.join(" ")).toContain("New headline");

    await approveProposal({ proposalId: proposal.id, userId: s.user_id });
    await expect(
      applySiteChange({ proposalId: proposal.id, fetcher: siteFetcher(), sleep: noSleep }),
    ).rejects.toThrow(/can't be edited programmatically/);
    expect(fixtureSiteRead(SITE)).toContain("Old headline"); // untouched
  });
});
