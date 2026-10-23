// P4-15 — the campaign executor's own surface, no database: the one way out
// to Resend sorts every answer into sent / refused / unknown honestly, it
// carries the RFC 8058 headers and a per-recipient idempotency key, and
// build gates hold who may call it and what the provider can do.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import {
  CAMPAIGN_PACE_MS,
  CAMPAIGN_RUN_CAP,
  createEmailCampaignExecutor,
  newUnsubscribeToken,
  sendCampaignEmail,
} from "./email-campaign";
import { executionProvider } from "./index";

const MAIL = {
  from: '"Emberworks via Ledgerline" <hello@send.syb.test>',
  to: "ann@customers.test",
  reply_to: "hello@emberworks.test",
  subject: "A note",
  text: "Hello.\n\nUnsubscribe: https://syb.test/u/tok",
  one_click_url: "https://syb.test/api/u/tok",
  idempotency_key: "syb-campaign-1",
  send_id: "0b6f3a52-6a1e-4c55-9d8e-2f0a1c3b4d5e",
};

const answering = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("P4-15 — sendCampaignEmail, the one way out", () => {
  it("posts to Resend with the key, the idempotency key and the RFC 8058 headers", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const out = await sendCampaignEmail(MAIL, "re_key", async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    });
    expect(out).toEqual({ kind: "sent", provider_id: "re_1" });
    expect(seen!.url).toBe("https://api.resend.com/emails");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers).toMatchObject({
      Authorization: "Bearer re_key",
      "Idempotency-Key": "syb-campaign-1",
    });
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      from: MAIL.from,
      to: [MAIL.to],
      reply_to: MAIL.reply_to,
      subject: MAIL.subject,
      text: MAIL.text,
      headers: {
        "List-Unsubscribe": "<https://syb.test/api/u/tok>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      // Review 2026-10-23 (#14): the row's id rides along as a tag, nothing personal.
      tags: [{ name: "syb_send", value: MAIL.send_id }],
    });
  });

  it("sorts every answer: a 4xx is refused (status only), a 5xx, a 409, a dropped line or an id-less 2xx is unknown", async () => {
    expect(
      await sendCampaignEmail(
        MAIL,
        "k",
        answering(422, { message: "ann@customers.test is invalid" }),
      ),
    ).toEqual({
      kind: "refused",
      status: 422,
    });
    expect((await sendCampaignEmail(MAIL, "k", answering(500, {}))).kind).toBe("unknown");
    expect((await sendCampaignEmail(MAIL, "k", answering(409, {}))).kind).toBe("unknown");
    expect((await sendCampaignEmail(MAIL, "k", answering(200, "not json"))).kind).toBe("unknown");
    expect((await sendCampaignEmail(MAIL, "k", answering(200, {}))).kind).toBe("unknown");
    expect(
      (
        await sendCampaignEmail(MAIL, "k", async () => {
          throw new TypeError("network");
        })
      ).kind,
    ).toBe("unknown");
  });
});

describe("P4-15 — the provider", () => {
  it("is registered, external (guard 6a applies), and its one op is irreversible", () => {
    const p = executionProvider("email_campaign");
    expect(p.id).toBe("email_campaign");
    expect(p.external).toBe(true);
    expect(EXECUTION_SCOPE_REGISTRY.email_campaign.operations).toEqual([
      expect.objectContaining({ op: "send_campaign", reversible: false }),
    ]);
  });

  it("undo says plainly that a sent email can't be recalled", async () => {
    const p = createEmailCampaignExecutor({ fetch: async () => new Response("{}") });
    await expect(p.undo("send_campaign", {}, { profile_id: "x", account_id: "y" })).rejects.toThrow(
      "A sent email can't be recalled. There is no undo for a campaign.",
    );
    expect(
      await p.captureUndo("send_campaign", {}, { profile_id: "x", account_id: "y" }),
    ).toBeNull();
  });

  it("refuses an unknown op or a send that names no campaign", async () => {
    const p = createEmailCampaignExecutor({ fetch: async () => new Response("{}") });
    const ctx = { profile_id: "x", account_id: "y", execution_id: "e" };
    await expect(p.execute("send_everything", { proposal_id: "p" }, ctx)).rejects.toThrow(
      /no "send_everything"/,
    );
    await expect(p.execute("send_campaign", {}, ctx)).rejects.toThrow(/names no campaign/);
  });

  it("tokens are 32 random bytes, url-safe, never repeated", () => {
    const a = newUnsubscribeToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newUnsubscribeToken()).not.toBe(a);
  });

  it("the per-run cap and the pace are pinned", () => {
    expect(CAMPAIGN_RUN_CAP).toBe(50);
    expect(CAMPAIGN_PACE_MS).toBe(600);
  });
});

/* ── the build gates ── */

const ROOT = process.cwd();
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SOURCES = ["app", "lib", "components", "scripts"].flatMap((d) =>
  sourceFiles(path.join(ROOT, d)),
);

describe("P4-15 — THE BUILD GATES", () => {
  it("sendCampaignEmail is called from exactly one place: the provider's per-recipient loop", () => {
    const sites = SOURCES.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [...src.matchAll(/\bsendCampaignEmail\(/g)]
        .filter((m) => !/function\s+$/.test(src.slice(Math.max(0, m.index - 16), m.index)))
        .map(() => rel(f));
    });
    expect(sites).toEqual(["lib/execution/providers/email-campaign.ts"]);
    const src = readFileSync(path.join(ROOT, "lib/execution/providers/email-campaign.ts"), "utf8");
    const execute = src.indexOf("async execute(op, params, ctx)");
    const call = src.indexOf("await sendCampaignEmail(");
    // Inside execute, after the halt check, the per-recipient check and the claim.
    expect(call).toBeGreaterThan(execute);
    expect(call).toBeGreaterThan(src.indexOf("ctx.halted && (await ctx.halted())", execute));
    expect(call).toBeGreaterThan(src.indexOf("await b.check(row, plan", execute));
    expect(call).toBeGreaterThan(src.indexOf("await b.claim(row.send_id", execute));
  });

  it("the campaign send runs only through the engine: nothing outside it calls the provider's execute", () => {
    const offenders = SOURCES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /emailCampaignExecutor\.execute\(|createEmailCampaignExecutor\([^)]*\)\.execute\(/.test(
        src,
      );
    }).map(rel);
    expect(offenders).toEqual([]);
    // The owner's send goes through executeProposal.
    const send = readFileSync(path.join(ROOT, "lib/crm/campaign-send.ts"), "utf8");
    const fn = send.slice(send.indexOf("export async function sendCampaignNow("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("executeProposal(");
  });

  it("no campaign module stores a body, an address or a name beside a send", () => {
    const schema = readFileSync(path.join(ROOT, "db/schema.ts"), "utf8");
    const table = schema.slice(
      schema.indexOf("export const campaignSends = pgTable("),
      schema.indexOf("export const jurisdictionReviews"),
    );
    expect(table).not.toMatch(/\b(email|address|name|body|text)\s*:\s*text\(/);
  });
});
