// P5-16b — the follow-up sender's own surface, no database (rule 29 amended
// by the owner on 2026-11-16). What must hold:
//   · registered, one irreversible op, external only when sending is real;
//   · while real sending is off it is HELD (deferred before any claim), and
//     while it is on, readiness speaks for the backend;
//   · it sends once: the approved body with the name filled, the postal
//     address and the unsubscribe line added, RFC 8058 headers, the
//     follow-up's own idempotency key;
//   · a refused consent sends nothing; a stop holds it; an unconfirmed send
//     or a row a dead run left sending is never sent again; a service-level
//     refusal releases the row and holds the run;
//   · the global fetch is never touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendingMode } from "../../purchasing/po";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import type { CampaignMailOutcome } from "./email-campaign";
import type { ExecutionContext } from "./fixture";
import type { FollowUpBackend, FollowUpCheck, FollowUpPlan } from "./followup-email";
import {
  FOLLOWUP_HELD,
  FOLLOWUP_UNCONFIRMED,
  composeFollowUp,
  createFollowUpExecutor,
  followUpIdempotencyKey,
  followUpSendingMode,
} from "./followup-email";
import { executionProvider } from "./index";

const PROPOSAL = "7d1f0a52-6a1e-4c55-9d8e-2f0a1c3b4d5e";
const REAL: () => SendingMode = () => ({
  mode: "real",
  api_key: "re_key",
  from_address: "hello@send.syb.test",
});
const OFF: () => SendingMode = () => ({ mode: "fake", reasons: ["real_writes_off"] });

const PLAN: FollowUpPlan = {
  proposal_id: PROPOSAL,
  from: '"Emberworks via ScaleX" <hello@send.syb.test>',
  from_address: "hello@send.syb.test",
  sender_name: "Emberworks",
  reply_to: "owner@emberworks.test",
  subject: "Checking in",
  body: "Hi {{name}},\n\nJust checking in.\n\nWritten with AI",
  disclosure: "Written with AI",
  postal_address: "1 Quay St, Dublin",
  base_url: "https://syb.test",
};

function ctx(halted = false): ExecutionContext {
  return {
    profile_id: "p",
    account_id: "a",
    execution_id: "e",
    attempt: 1,
    halted: async () => halted,
  };
}

interface Fake extends FollowUpBackend {
  rows: { send_id: string; status: string }[];
  refused: string[][];
  recorded: CampaignMailOutcome[];
  released: number;
  verdict: FollowUpCheck;
  ready: string | null;
}

function fakeBackend(overrides: Partial<Fake> = {}): Fake {
  const b: Fake = {
    rows: [],
    refused: [],
    recorded: [],
    released: 0,
    verdict: {
      ok: true,
      contact_id: "c",
      email: "aoife@cafenua.example",
      email_hash: "h1:x",
      name: "Aoife Nua",
    },
    ready: null,
    async readiness() {
      return b.ready;
    },
    async plan() {
      return b.ready === null ? PLAN : { refused: b.ready };
    },
    async prior() {
      return b.rows[0] ?? null;
    },
    async settleInterrupted() {
      for (const r of b.rows) if (r.status === "sending") r.status = "unknown";
    },
    async check() {
      return b.verdict;
    },
    async refuse(_p, _c, codes) {
      b.refused.push(codes);
    },
    async claim() {
      const row = b.rows[0];
      if (row && row.status !== "pending") return null;
      if (!row) b.rows.push({ send_id: "s1", status: "sending" });
      else row.status = "sending";
      return { send_id: "s1", idempotency_key: followUpIdempotencyKey(PROPOSAL) };
    },
    async record(_id, outcome) {
      b.recorded.push(outcome);
      b.rows[0]!.status =
        outcome.kind === "sent" ? "sent" : outcome.kind === "refused" ? "failed" : "unknown";
    },
    async release() {
      b.released += 1;
      b.rows[0]!.status = "pending";
    },
    ...overrides,
  };
  return b;
}

function fakeFetch(answer: () => Response) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
    [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    return answer();
  };
  return Object.assign(f, { calls });
}

const sent = () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
const params = { proposal_id: PROPOSAL };

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the global fetch must never be touched");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P5-16b — the provider", () => {
  it("is registered with one irreversible op, and is external only when sending is real", () => {
    const p = executionProvider("followup_email");
    expect(p.id).toBe("followup_email");
    expect(EXECUTION_SCOPE_REGISTRY.followup_email.operations).toEqual([
      expect.objectContaining({ op: "send_followup", reversible: false }),
    ]);
    expect(createFollowUpExecutor({ mode: REAL }).external).toBe(true);
    expect(createFollowUpExecutor({ mode: OFF }).external).toBe(false);
  });

  it("prefers the campaign sending address, and needs the real-write switch", () => {
    const base = { RESEND_API_KEY: "re_k", EMAIL_FROM: "ScaleX <login@syb.test>" };
    expect(followUpSendingMode(base)).toEqual({
      mode: "fake",
      reasons: ["real_writes_off"],
    });
    expect(
      followUpSendingMode({
        ...base,
        CAMPAIGN_EMAIL_FROM: "ScaleX <hello@send.syb.test>",
        SESSION_D_REAL_WRITES: "on",
      }),
    ).toEqual({ mode: "real", api_key: "re_k", from_address: "hello@send.syb.test" });
  });

  it("is held while real sending is off: deferred, before the backend is asked anything", async () => {
    const backend = fakeBackend({ ready: "should not be read" });
    const p = createFollowUpExecutor({ mode: OFF, backend });
    const refusal = await p.preflight!("send_followup", params, ctx());
    expect(refusal?.code).toBe("deferred");
    expect(refusal?.message.startsWith(FOLLOWUP_HELD)).toBe(true);
    expect(refusal?.message).toMatch(/two-week unattended test/);
    await expect(p.execute("send_followup", params, ctx())).rejects.toThrow(/Nothing was sent/);
    expect(backend.rows).toEqual([]);
  });

  it("with sending on, readiness speaks for the backend", async () => {
    const backend = fakeBackend({ ready: "You haven't approved the email itself yet." });
    const p = createFollowUpExecutor({ mode: REAL, backend });
    expect(await p.preflight!("send_followup", params, ctx())).toEqual({
      code: "refused",
      message: "You haven't approved the email itself yet.",
    });
  });

  it("sends once: name filled, address and unsubscribe added, headers and key set", async () => {
    const backend = fakeBackend();
    const f = fakeFetch(sent);
    const p = createFollowUpExecutor({ mode: REAL, backend, fetch: f });
    const result = await p.execute("send_followup", params, ctx());
    expect(result).toMatchObject({ sent: true, provider_id: "re_1", already: false });
    expect(f.calls).toHaveLength(1);
    const body = f.calls[0]!.body;
    expect(f.calls[0]!.headers["Idempotency-Key"]).toBe(`syb-followup-${PROPOSAL}`);
    expect(body).toMatchObject({
      from: PLAN.from,
      to: ["aoife@cafenua.example"],
      reply_to: PLAN.reply_to,
      subject: "Checking in",
    });
    const text = String(body.text);
    expect(text.startsWith("Hi Aoife,\n\nJust checking in.\n\nWritten with AI")).toBe(true);
    expect(text).toContain("1 Quay St, Dublin");
    expect(text).toMatch(/unsubscribe here: https:\/\/syb\.test\/u\/[A-Za-z0-9_-]{43}$/);
    const headers = body.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/syb\.test\/api\/u\/[A-Za-z0-9_-]{43}>$/,
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // A second run finds it sent and sends nothing.
    const again = await p.execute("send_followup", params, ctx());
    expect(again).toMatchObject({ sent: true, already: true });
    expect(f.calls).toHaveLength(1);
  });

  it("a refused consent sends nothing and says why", async () => {
    const backend = fakeBackend({
      verdict: { ok: false, codes: ["suppressed"], words: "suppressed (unsubscribed)" },
    });
    const f = fakeFetch(sent);
    const p = createFollowUpExecutor({ mode: REAL, backend, fetch: f });
    await expect(p.execute("send_followup", params, ctx())).rejects.toThrow(
      /Not sent: suppressed \(unsubscribed\)/,
    );
    expect(backend.refused).toEqual([["suppressed"]]);
    expect(f.calls).toEqual([]);
  });

  it("the stop holds it before anything is sent", async () => {
    const backend = fakeBackend();
    const f = fakeFetch(sent);
    const p = createFollowUpExecutor({ mode: REAL, backend, fetch: f });
    await expect(p.execute("send_followup", params, ctx(true))).rejects.toMatchObject({
      held_for: "stop",
    });
    expect(f.calls).toEqual([]);
    expect(backend.rows).toEqual([]);
  });

  it("an unconfirmed send is never sent again, nor a row a dead run left sending", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 500 }));
    const backend = fakeBackend();
    const p = createFollowUpExecutor({ mode: REAL, backend, fetch: f });
    await expect(p.execute("send_followup", params, ctx())).rejects.toThrow(FOLLOWUP_UNCONFIRMED);
    expect(backend.rows[0]!.status).toBe("unknown");
    await expect(p.execute("send_followup", params, ctx())).rejects.toThrow(/won't send it again/);
    expect(f.calls).toHaveLength(1);

    const dead = fakeBackend({ rows: [{ send_id: "s1", status: "sending" }] });
    const g = fakeFetch(sent);
    await expect(
      createFollowUpExecutor({ mode: REAL, backend: dead, fetch: g }).execute(
        "send_followup",
        params,
        ctx(),
      ),
    ).rejects.toThrow(FOLLOWUP_UNCONFIRMED);
    expect(dead.rows[0]!.status).toBe("unknown");
    expect(g.calls).toEqual([]);
  });

  it("a service-level refusal releases the row and holds the run; a 4xx about the email fails it", async () => {
    const backend = fakeBackend();
    const p = createFollowUpExecutor({
      mode: REAL,
      backend,
      fetch: fakeFetch(() => new Response("{}", { status: 429 })),
    });
    await expect(p.execute("send_followup", params, ctx())).rejects.toMatchObject({
      held_for: "remaining",
    });
    expect(backend.released).toBe(1);
    expect(backend.rows[0]!.status).toBe("pending");

    const refusing = fakeBackend();
    await expect(
      createFollowUpExecutor({
        mode: REAL,
        backend: refusing,
        fetch: fakeFetch(() => new Response("{}", { status: 422 })),
      }).execute("send_followup", params, ctx()),
    ).rejects.toThrow(/refused the follow-up \(it answered 422\)/);
    expect(refusing.rows[0]!.status).toBe("failed");
  });

  it("has no undo: a sent email can't be recalled", async () => {
    await expect(
      createFollowUpExecutor({ mode: REAL }).undo("send_followup", {}, ctx()),
    ).rejects.toThrow(/can't be recalled/);
  });

  it("composes only what it says it adds", () => {
    expect(
      composeFollowUp({
        body: "Hi {{name}},\n\nHello.\n\nWritten with AI\n",
        name: null,
        postal_address: null,
        unsubscribe_url: "https://syb.test/u/t",
      }),
    ).toBe(
      "Hi there,\n\nHello.\n\nWritten with AI\n\nIf you'd rather not get emails like this, unsubscribe here: https://syb.test/u/t",
    );
  });
});
