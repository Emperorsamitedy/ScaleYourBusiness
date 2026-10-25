// The four smoke tests' flows (scripts/smoke/{email,inbound,erasure,widget}.ts)
// against fake env and fake clients: each refuses clearly without its keys,
// its arguments or --yes, and does nothing when it refuses; each prints
// numbered PASS / FAIL lines; and none prints a secret, checked with an env
// full of sentinel values.

import { describe, expect, it, vi } from "vitest";
import type { SendResult } from "../../lib/auth/email";
import { EXIT_FAIL, EXIT_PASS, EXIT_REFUSED } from "./common";
import { runSmokeEmail } from "./email";
import type { ErasureDeps, LogEntry } from "./erasure";
import { TEST_NAME, piiInLog, runSmokeErasure, throwawayAddress } from "./erasure";
import type { InboundDeps, InboundLanding } from "./inbound";
import { runSmokeInbound } from "./inbound";
import type { WidgetDeps } from "./widget";
import { runSmokeWidget } from "./widget";

/** Every value here must never reach a printed line. */
const SENTINELS = {
  RESEND_API_KEY: "re_SENTINEL_resend_7f3a9c",
  DATABASE_URL: "postgresql://syb:SENTINEL_dbpass_51e2@db.prod.example:5432/syb",
  CONNECTOR_KEY: "SENTINEL_connector_key_0b4d8e2f",
  RESEND_WEBHOOK_SECRET: "whsec_SENTINEL_inbound_c19a",
  ANTHROPIC_API_KEY: "sk-ant-SENTINEL_anthropic_e4f1",
  STRIPE_SECRET_KEY: "sk_live_SENTINEL_stripe_77aa",
};

const ENV = {
  ...SENTINELS,
  EMAIL_FROM: "SYB <hello@syb.example>",
  APP_URL: "https://app.syb.example",
  SUPPORT_INBOUND_DOMAIN: "inbound.syb.example",
};

const PROFILE = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "99999999-2222-4333-8444-555555555555";

function capture() {
  const lines: string[] = [];
  return { lines, print: (l: string) => lines.push(l), text: () => lines.join("\n") };
}

function assertNoSecret(text: string) {
  expect(text).not.toContain("SENTINEL");
  for (const v of Object.values(SENTINELS)) expect(text).not.toContain(v);
}

/* ── smoke:email ── */

describe("smoke:email", () => {
  const accepted: SendResult = { delivered_via: "resend", provider: { status: 200, id: "em_42" } };

  it("refuses without its keys, an address, a real sender, https or --yes — and sends nothing", async () => {
    const send = vi.fn(async () => accepted);
    const cases: [Record<string, string | undefined>, string[]][] = [
      [{ ...ENV, RESEND_API_KEY: "" }, ["--to", "me@syb.example", "--yes"]],
      [ENV, ["--yes"]],
      [{ ...ENV, EMAIL_FROM: "SYB <onboarding@resend.dev>" }, ["--to", "me@x.example", "--yes"]],
      [{ ...ENV, APP_URL: "http://app.syb.example" }, ["--to", "me@x.example", "--yes"]],
      [ENV, ["--to", "me@x.example"]],
    ];
    for (const [env, argv] of cases) {
      const out = capture();
      expect(await runSmokeEmail({ env, argv, print: out.print, deps: { send } })).toBe(
        EXIT_REFUSED,
      );
      expect(out.text()).toContain("REFUSED");
      assertNoSecret(out.text());
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once through the given path and reports Resend's status and id", async () => {
    const send = vi.fn(async () => accepted);
    const out = capture();
    const code = await runSmokeEmail({
      env: ENV,
      argv: ["--to", "me@syb.example", "--yes"],
      print: out.print,
      deps: { send },
    });
    expect(code).toBe(EXIT_PASS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      to: "me@syb.example",
      link: "https://app.syb.example/login",
    });
    expect(out.text()).toContain("1. PASS  Resend accepted the email: status 200, id em_42.");
    expect(out.text()).toContain("db.prod.example:5432/syb as syb, password ***");
    assertNoSecret(out.text());
  });

  it("a refusal from Resend is a numbered FAIL with its status, and exit 1", async () => {
    const out = capture();
    const code = await runSmokeEmail({
      env: ENV,
      argv: ["--to", "me@syb.example", "--yes"],
      print: out.print,
      deps: {
        send: async () => ({ delivered_via: "failed", provider: { status: 403, id: null } }),
      },
    });
    expect(code).toBe(EXIT_FAIL);
    expect(out.text()).toContain("1. FAIL  Resend refused the email: status 403.");
    assertNoSecret(out.text());
  });
});

/* ── smoke:inbound ── */

function inboundDeps(over: Partial<InboundDeps> = {}, landingAfter = 2): InboundDeps {
  let clock = 0;
  let polls = 0;
  const landing: InboundLanding = {
    ticket_id: "t-1",
    channel: "email",
    status: "open",
    sender_auth: "verified",
    has_contact: true,
    suppressed_address: false,
  };
  return {
    inboundToken: async () => "a".repeat(32),
    seenMessageIds: async () => ["old-1"],
    findLanding: async (_p, _f, seen) => {
      expect(seen).toEqual(["old-1"]);
      polls += 1;
      return polls > landingAfter ? landing : null;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
}

describe("smoke:inbound", () => {
  it("refuses without its keys, a profile id, a sender, or when the sender is SYB's own", async () => {
    const cases: [Record<string, string | undefined>, string[]][] = [
      [{ ...ENV, SUPPORT_INBOUND_DOMAIN: "" }, ["--profile", PROFILE, "--from", "me@x.example"]],
      [ENV, ["--profile", "nope", "--from", "me@x.example"]],
      [ENV, ["--profile", PROFILE]],
      [ENV, ["--profile", PROFILE, "--from", "hello@syb.example"]],
    ];
    for (const [env, argv] of cases) {
      const findLanding = vi.fn(async () => null);
      const out = capture();
      expect(
        await runSmokeInbound({ env, argv, print: out.print, deps: inboundDeps({ findLanding }) }),
      ).toBe(EXIT_REFUSED);
      expect(findLanding).not.toHaveBeenCalled();
      assertNoSecret(out.text());
    }
  });

  it("prints the inbound address and steps, then PASSes when a new ticket from the sender lands", async () => {
    const out = capture();
    const code = await runSmokeInbound({
      env: ENV,
      argv: ["--profile", PROFILE, "--from", "Me@X.example"],
      print: out.print,
      deps: inboundDeps(),
    });
    expect(code).toBe(EXIT_PASS);
    expect(out.text()).toContain(`s-${"a".repeat(32)}@inbound.syb.example`);
    expect(out.text()).toContain("From me@x.example, write a new email");
    expect(out.text()).toMatch(/2\. PASS {2}A ticket landed from me@x\.example: ticket t-1/);
    expect(out.text()).toContain("3. PASS  The ticket's channel is email.");
    assertNoSecret(out.text());
  });

  it("FAILs after the timeout when nothing lands, naming what to check", async () => {
    const out = capture();
    const code = await runSmokeInbound({
      env: ENV,
      argv: ["--profile", PROFILE, "--from", "me@x.example", "--timeout", "30"],
      print: out.print,
      deps: inboundDeps({}, Number.POSITIVE_INFINITY),
    });
    expect(code).toBe(EXIT_FAIL);
    expect(out.text()).toContain("No ticket from me@x.example within 30 seconds");
    expect(out.text()).toContain("https://app.syb.example/api/support/inbound");
    assertNoSecret(out.text());
  });

  it("FAILs at once when the business has no support settings", async () => {
    const out = capture();
    const code = await runSmokeInbound({
      env: ENV,
      argv: ["--profile", PROFILE, "--from", "me@x.example"],
      print: out.print,
      deps: inboundDeps({ inboundToken: async () => null }),
    });
    expect(code).toBe(EXIT_FAIL);
    expect(out.text()).toContain("1. FAIL  This business has no support settings yet.");
  });
});

/* ── smoke:erasure ── */

function erasureDeps(over: Partial<ErasureDeps> = {}) {
  const calls: string[] = [];
  const log: LogEntry[] = [];
  const deps: ErasureDeps = {
    profileOf: async () => PROFILE,
    addContact: async () => {
      calls.push("add");
      return "c-1";
    },
    eraseContact: async (_a, id) => {
      calls.push("erase");
      log.push({ id: "d-1", kind: "erasure", ref_id: id, payload_hash: "a".repeat(64) });
    },
    contactExists: async () => false,
    suppressedReason: async () => "erasure",
    readdRefused: async () => true,
    decisionLog: async () => log,
    cleanup: async () => {
      calls.push("cleanup");
      return { suppressions: 1, booking_keys: 0 };
    },
    deleteContact: async () => {
      calls.push("delete");
    },
    ...over,
  };
  return { deps, calls, log };
}

describe("smoke:erasure", () => {
  it("piiInLog finds an entry holding the address or name, and passes a clean log", () => {
    const clean: LogEntry[] = [
      { id: "1", kind: "erasure", ref_id: "c-1", payload_hash: "f".repeat(64) },
    ];
    expect(piiInLog(clean, ["smoke@example.test", "smoke", TEST_NAME])).toEqual([]);
    const dirty = [
      ...clean,
      { id: "2", kind: "profile_change", ref_id: "Smoke@Example.test", payload_hash: "x" },
    ];
    expect(piiInLog(dirty, ["smoke@example.test"]).map((e) => e.id)).toEqual(["2"]);
  });

  it("throwawayAddress is always on a reserved domain, and fresh each time", () => {
    const a = throwawayAddress();
    expect(a).toMatch(/^smoke-erasure-[0-9a-f]{12}@example\.test$/);
    expect(throwawayAddress()).not.toBe(a);
  });

  it("refuses without its keys, an account, a reserved address or --yes — and writes nothing", async () => {
    const cases: [Record<string, string | undefined>, string[]][] = [
      [{ ...ENV, CONNECTOR_KEY: "" }, ["--account", ACCOUNT, "--yes"]],
      [ENV, ["--yes"]],
      [ENV, ["--account", ACCOUNT, "--email", "someone@gmail.com", "--yes"]],
      [ENV, ["--account", ACCOUNT]],
    ];
    for (const [env, argv] of cases) {
      const { deps, calls } = erasureDeps();
      const out = capture();
      expect(await runSmokeErasure({ env, argv, print: out.print, deps })).toBe(EXIT_REFUSED);
      expect(calls).toEqual([]);
      assertNoSecret(out.text());
    }
  });

  it("walks add → erase → the three checks → cleanup, all PASS, tally after cleanup", async () => {
    const { deps, calls } = erasureDeps();
    const out = capture();
    const code = await runSmokeErasure({
      env: ENV,
      argv: ["--account", ACCOUNT, "--email", "smoke-1@example.test", "--yes"],
      print: out.print,
      deps,
    });
    expect(code).toBe(EXIT_PASS);
    expect(calls).toEqual(["add", "erase", "cleanup"]);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(out.text()).toContain(`${n}. PASS`);
    expect(out.lines.at(-1)).toBe("All 8 checks passed.");
    expect(out.lines.at(-2)).toContain("Cleanup: removed 1 suppression row");
    assertNoSecret(out.text());
  });

  it("each broken promise is a FAIL: the row stays, no suppression, re-add allowed, PII in the log", async () => {
    const { deps } = erasureDeps({
      contactExists: async () => true,
      suppressedReason: async () => null,
      readdRefused: async () => false,
      decisionLog: async () => [
        { id: "d-1", kind: "erasure", ref_id: "c-1", payload_hash: "a".repeat(64) },
        { id: "d-2", kind: "note", ref_id: "smoke-1@example.test", payload_hash: "b" },
      ],
    });
    const out = capture();
    const code = await runSmokeErasure({
      env: ENV,
      argv: ["--account", ACCOUNT, "--email", "smoke-1@example.test", "--yes"],
      print: out.print,
      deps,
    });
    expect(code).toBe(EXIT_FAIL);
    expect(out.text()).toContain("FAIL  The contact row is still there.");
    expect(out.text()).toContain("FAIL  No suppression stands for the address.");
    expect(out.text()).toContain("FAIL  Re-adding the address was allowed.");
    expect(out.text()).toContain("FAIL  1 decision-log entry holds the address or the name: d-2.");
  });

  it("an erasure that throws removes the throwaway row directly, and still cleans up", async () => {
    const { deps, calls } = erasureDeps({
      eraseContact: async () => {
        throw new Error("boom");
      },
    });
    const out = capture();
    const code = await runSmokeErasure({
      env: ENV,
      argv: ["--account", ACCOUNT, "--yes"],
      print: out.print,
      deps,
    });
    expect(code).toBe(EXIT_FAIL);
    expect(calls).toEqual(["add", "delete", "cleanup"]);
    expect(out.text()).toContain("FAIL  The run stopped: boom");
  });
});

/* ── smoke:widget ── */

function widgetDeps(over: Partial<WidgetDeps> = {}): WidgetDeps {
  return {
    settings: async () => ({ site_key: "b".repeat(32), business_name: "Kovács Bakery" }),
    approvedKnowledge: async () => 3,
    ...over,
  };
}

describe("smoke:widget", () => {
  it("refuses without its keys, https or a profile id", async () => {
    for (const [env, argv] of [
      [{ ...ENV, APP_URL: "" }, ["--profile", PROFILE]],
      [{ ...ENV, APP_URL: "http://x.example" }, ["--profile", PROFILE]],
      [ENV, []],
    ] as [Record<string, string>, string[]][]) {
      const settings = vi.fn(async () => null);
      const out = capture();
      expect(
        await runSmokeWidget({ env, argv, print: out.print, deps: widgetDeps({ settings }) }),
      ).toBe(EXIT_REFUSED);
      expect(settings).not.toHaveBeenCalled();
    }
  });

  it("prints the site key, the snippet, the test page and what to check", async () => {
    const out = capture();
    const code = await runSmokeWidget({
      env: ENV,
      argv: ["--profile", PROFILE],
      print: out.print,
      deps: widgetDeps(),
    });
    expect(code).toBe(EXIT_PASS);
    const t = out.text();
    expect(t).toContain(`Site key (public by design): ${"b".repeat(32)}`);
    expect(t).toContain(
      `<script src="https://app.syb.example/support-widget.js" data-site-key="${"b".repeat(32)}" async></script>`,
    );
    expect(t).toContain("https://app.syb.example/support/test");
    expect(t).toContain("automated assistant");
    expect(t).toContain("ask for a person");
    assertNoSecret(t);
  });

  it("FAILs when the business has no settings, or nothing published to answer from", async () => {
    const none = capture();
    expect(
      await runSmokeWidget({
        env: ENV,
        argv: ["--profile", PROFILE],
        print: none.print,
        deps: widgetDeps({ settings: async () => null }),
      }),
    ).toBe(EXIT_FAIL);
    const empty = capture();
    expect(
      await runSmokeWidget({
        env: ENV,
        argv: ["--profile", PROFILE],
        print: empty.print,
        deps: widgetDeps({ approvedKnowledge: async () => 0 }),
      }),
    ).toBe(EXIT_FAIL);
    expect(empty.text()).toContain("2. FAIL  No knowledge is published");
  });
});
