// I-52.2: no route lets a session for business A read or change business
// B — held two ways.
//
//   1. Structurally, over every route under app/api: each one resolves its
//      business through the one door (lib/auth/access's resolveAccess /
//      matchingSession, or the auth session itself), or is a listed public
//      route with its own credential — and none takes a business id from
//      the request to choose which business it acts on.
//   2. With real requests: A's real session and cookies, through the real
//      door (only next/headers' cookie jar is stood in), against B's ids on
//      a sample of routes — and the roles on the same routes.

import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { authSessions, decisionLog, modeDecisions, proposals, users } from "../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../../lib/auth/access";
import { createInvite } from "../../lib/auth/members";
import type { Role } from "../../lib/auth/roles";
import { currentSession, openSession } from "../../lib/auth/service";
import { bootstrapIntake } from "../../lib/intake/service";
import { createProposal } from "../../lib/proposals/service";

// ── 1. structural ──

const ROOT = join(process.cwd(), "app", "api");

/** Routes with no business session at all — each has its own credential, or none to give. */
export const PUBLIC: Record<string, string> = {
  "auth/login/route.ts": "asks for a sign-in link; reads no business",
  "auth/logout/route.ts": "ends this browser's session",
  "auth/redeem/route.ts": "redeems a sign-in link",
  "auth/oauth/[provider]/start/route.ts": "starts a provider sign-in",
  "auth/oauth/[provider]/callback/route.ts": "finishes a provider sign-in",
  "cron/competitor-read/route.ts": "Vercel cron, CRON_SECRET",
  "cron/connector-sync/route.ts": "Vercel cron, CRON_SECRET",
  "cron/execute-due/route.ts": "Vercel cron, CRON_SECRET",
  "cron/faq-cluster/route.ts": "Vercel cron, CRON_SECRET",
  "cron/push-held/route.ts": "Vercel cron, CRON_SECRET (idea 53's held phone alerts)",
  "cron/render-footage/route.ts": "Vercel cron, CRON_SECRET",
  "cron/weekly-watch/route.ts": "Vercel cron, CRON_SECRET",
  "debug-sentry/route.ts": "throws on purpose, SENTRY_TEST_KEY",
  "email/events/route.ts": "Resend webhook, Svix-signed",
  "ops/route.ts": "operator panel, OPS_KEY",
  "ops/campaign-review/route.ts": "operator panel, OPS_KEY",
  "ops/law-review/route.ts": "operator panel, OPS_KEY",
  "phone/voice/route.ts": "Twilio voice webhook, X-Twilio-Signature (P6-02)",
  "stripe/webhook/route.ts": "Stripe webhook, signature-verified",
  "summary/stop/[token]/route.ts": "one-click stop, the signed token",
  "support/inbound/route.ts": "Resend inbound webhook, Svix-signed",
  "support/public/route.ts": "the public widget: a site key and a conversation token",
  "u/[token]/route.ts": "one-click unsubscribe, the signed token",
};

/** Where a business id in the request is legitimate, and why. */
const ID_FROM_REQUEST: Record<string, string> = {
  "auth/switch/route.ts":
    "the business to move to — opened only for the users row whose email is exactly the session's",
  "checkout/route.ts":
    "I-52a: other businesses to add to the same payment — each must be one the session's own email owns, from membershipsFor, never acted on beyond a payment row",
};

const DOOR = /\bresolveAccess\(|\bmatchingSession\(|\bcurrentSession\(|\bsession\(\)/;
/** A business id read off the request: a body/form/query field naming a profile or account. */
const BUSINESS_ID_FROM_REQUEST =
  /\b(?:body|input|form|params|searchParams|query)\??\.(?:profile_id|account_id)\b|\.get\("(?:profile_id|account_id)"\)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const files = walk(ROOT).map((p) => ({
  rel: relative(ROOT, p).split(sep).join("/"),
  source: readFileSync(p, "utf8"),
}));

describe("structurally: one door, and no business id from the request", () => {
  it("the scanners catch what they're for", () => {
    expect(DOOR.test("const access = await resolveAccess();")).toBe(true);
    expect(DOOR.test("const id = request.headers.get('x');")).toBe(false);
    expect(BUSINESS_ID_FROM_REQUEST.test("readProfile(body.profile_id)")).toBe(true);
    expect(BUSINESS_ID_FROM_REQUEST.test('form.get("account_id")')).toBe(true);
    expect(BUSINESS_ID_FROM_REQUEST.test("readProfile(access.profile_id)")).toBe(false);
  });

  it("every route goes through the door, or is a listed public route", () => {
    const strays = files
      .filter((f) => !DOOR.test(f.source) && !PUBLIC[f.rel])
      .map((f) => `app/api/${f.rel}`);
    expect(
      strays,
      "these routes read no session: route them through lib/auth/access (resolveAccess), or list them in PUBLIC with their own credential",
    ).toEqual([]);
    for (const rel of Object.keys(PUBLIC)) {
      expect(
        files.some((f) => f.rel === rel),
        `PUBLIC lists app/api/${rel}, which is gone`,
      ).toBe(true);
    }
  });

  it("no route chooses its business from the request", () => {
    const strays = files
      .filter((f) => BUSINESS_ID_FROM_REQUEST.test(f.source) && !ID_FROM_REQUEST[f.rel])
      .map((f) => `app/api/${f.rel}`);
    expect(
      strays,
      "a profile or account id from the request: take it from the session (resolveAccess) instead",
    ).toEqual([]);
  });

  it("a public route never imports the session door", () => {
    for (const rel of Object.keys(PUBLIC)) {
      if (rel.startsWith("auth/")) continue; // sign-in builds sessions; it doesn't read a business
      const f = files.find((x) => x.rel === rel);
      expect(f?.source ?? "", rel).not.toMatch(/\bresolveAccess\(/);
    }
  });
});

// ── 2. real requests ──

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { GET: profileGET } = await import("./profile/route");
const { PUT: proposalsPUT } = await import("./proposals/route");
const { GET: membersGET, POST: membersPOST } = await import("./members/route");
const { POST: switchPOST } = await import("./auth/switch/route");
const { POST: connectionsPOST } = await import("./connections/route");
const { POST: stopPOST, DELETE: stopDELETE } = await import("./stop/route");
const { GET: navGET } = await import("./nav/route");
const { POST: reviewsPOST } = await import("./reviews/route");

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

interface Biz {
  account_id: string;
  profile_id: string;
  owner: { user_id: string; email: string; token: string };
}

async function business(
  email = `iso-${crypto.randomUUID().slice(0, 8)}@example.com`,
): Promise<Biz> {
  const boot = await bootstrapIntake();
  await db.insert(modeDecisions).values({
    profile_id: boot.profile_id,
    mode: "instant",
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const member = await addMember(boot.account_id, email, "owner");
  return { ...boot, owner: member };
}

async function addMember(accountId: string, email: string, role: Role) {
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "iso", role })
    .returning();
  if (!u) throw new Error("fixture user");
  const s = await openSession(u);
  return { user_id: u.id, email, token: s.session_token };
}

function signInAs(token: string, profileId: string) {
  jar.clear();
  jar.set(AUTH_COOKIE, token);
  jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
}

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

const pendingProposal = (profileId: string) =>
  createProposal({
    profile_id: profileId,
    module: "diagnosis",
    action: { kind: "operations_change", summary: "isolation fixture" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });

describe("real requests: A's session against B's ids", () => {
  it("never opens B's profile with A's session, even holding B's signed cookie", async () => {
    const a = await business();
    const b = await business();
    signInAs(a.owner.token, b.profile_id); // A's session, B's (validly signed) intake cookie
    expect((await profileGET()).status).toBe(401);
    expect((await membersGET()).status).toBe(401);
    expect((await navGET()).status).toBe(401);
    signInAs(a.owner.token, a.profile_id);
    expect((await profileGET()).status).toBe(200);
  });

  it("can't decide B's proposal from A's queue", async () => {
    const a = await business();
    const b = await business();
    const target = await pendingProposal(b.profile_id);
    signInAs(a.owner.token, a.profile_id);
    const res = await proposalsPUT(
      json("/api/proposals", "PUT", { ids: [target.id], decision: "approve" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).failed[0].error).toBe("no such proposal");
    const [row] = await db.select().from(proposals).where(eq(proposals.id, target.id));
    expect(row?.status).toBe("pending");
  });

  it("can't remove, re-role or un-invite anyone on B's team", async () => {
    const a = await business();
    const b = await business();
    const bViewer = await addMember(
      b.account_id,
      `iso-v-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "viewer",
    );
    const { invite } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.user_id,
      email: `iso-i-${crypto.randomUUID().slice(0, 6)}@example.com`,
      role: "viewer",
    });
    signInAs(a.owner.token, a.profile_id);
    for (const body of [
      { action: "remove", user_id: bViewer.user_id },
      { action: "set_role", user_id: bViewer.user_id, role: "owner" },
      { action: "remove", user_id: b.owner.user_id },
      { action: "revoke_invite", invite_id: invite.id },
    ]) {
      const res = await membersPOST(json("/api/members", "POST", body));
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    const [v] = await db.select().from(users).where(eq(users.id, bViewer.user_id));
    expect(v?.role).toBe("viewer");
    expect(v?.removed_at).toBeNull();
    expect(await currentSession(bViewer.token)).not.toBeNull();
    // And A's own list names only A's people.
    const list = (await (await membersGET()).json()) as { members: { email: string }[] };
    expect(list.members.map((m) => m.email)).toEqual([a.owner.email]);
  });

  it("can't switch into a business whose team doesn't have exactly this email", async () => {
    const a = await business();
    const b = await business();
    signInAs(a.owner.token, a.profile_id);
    const form = new URLSearchParams({ account_id: b.account_id });
    const res = await switchPOST(
      new NextRequest("http://localhost:3000/api/auth/switch", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: form.toString(),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login/choose?error=no%20such%20business");
    const bSessions = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.user_id, b.owner.user_id));
    expect(bSessions).toHaveLength(1); // only its own fixture session
    expect(await currentSession(a.owner.token)).not.toBeNull(); // A's session untouched
  });
});

describe("real requests: the roles on the same routes", () => {
  it("a viewer can't approve, and reads why", async () => {
    const biz = await business();
    const viewer = await addMember(
      biz.account_id,
      `iso-v-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "viewer",
    );
    const target = await pendingProposal(biz.profile_id);
    signInAs(viewer.token, biz.profile_id);
    const res = await proposalsPUT(
      json("/api/proposals", "PUT", { ids: [target.id], decision: "approve" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only an owner or a manager can approve or decline proposals.",
    );
    const [row] = await db.select().from(proposals).where(eq(proposals.id, target.id));
    expect(row?.status).toBe("pending");
  });

  it("a manager can approve — and the log records which person did", async () => {
    const biz = await business();
    const manager = await addMember(
      biz.account_id,
      `iso-m-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "manager",
    );
    const target = await pendingProposal(biz.profile_id);
    signInAs(manager.token, biz.profile_id);
    const res = await proposalsPUT(
      json("/api/proposals", "PUT", { ids: [target.id], decision: "approve" }),
    );
    expect(res.status).toBe(200);
    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, target.id), eq(decisionLog.kind, "approval")));
    expect(entry?.user_id).toBe(manager.user_id);
  });

  it("a manager can't connect an account", async () => {
    const biz = await business();
    const manager = await addMember(
      biz.account_id,
      `iso-m-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "manager",
    );
    signInAs(manager.token, biz.profile_id);
    const res = await connectionsPOST(
      json("/api/connections", "POST", { provider: "stripe", secret: "rk_test_x" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only an owner can connect or disconnect accounts.");
  });

  it("a viewer can press stop, but only an owner starts again", async () => {
    const biz = await business();
    const viewer = await addMember(
      biz.account_id,
      `iso-v-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "viewer",
    );
    signInAs(viewer.token, biz.profile_id);
    expect((await stopPOST(json("/api/stop", "POST", {}))).status).toBe(200);
    expect((await stopDELETE()).status).toBe(403);
    signInAs(biz.owner.token, biz.profile_id);
    expect((await stopDELETE()).status).toBe(200);
  });

  it("reviews: a viewer can't paste one, and a manager can't change the forwarding address", async () => {
    const biz = await business();
    const viewer = await addMember(
      biz.account_id,
      `iso-v-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "viewer",
    );
    const manager = await addMember(
      biz.account_id,
      `iso-m-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "manager",
    );
    signInAs(viewer.token, biz.profile_id);
    const paste = await reviewsPOST(json("/api/reviews", "POST", { action: "paste", stars: "1" }));
    expect(paste.status).toBe(403);
    expect((await paste.json()).error).toBe(
      "Only an owner or a manager can file, answer or remove reviews.",
    );
    signInAs(manager.token, biz.profile_id);
    const rotate = await reviewsPOST(json("/api/reviews", "POST", { action: "rotate" }));
    expect(rotate.status).toBe(403);
    expect((await rotate.json()).error).toBe(
      "Only an owner can change the address reviews are forwarded to.",
    );
  });

  it("a removed member's session opens nothing", async () => {
    const biz = await business();
    const manager = await addMember(
      biz.account_id,
      `iso-m-${crypto.randomUUID().slice(0, 6)}@example.com`,
      "manager",
    );
    signInAs(biz.owner.token, biz.profile_id);
    const res = await membersPOST(
      json("/api/members", "POST", { action: "remove", user_id: manager.user_id }),
    );
    expect(res.status).toBe(200);
    expect(await currentSession(manager.token)).toBeNull();
    signInAs(manager.token, biz.profile_id);
    expect((await profileGET()).status).toBe(401);
    const live = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.user_id, manager.user_id), isNull(authSessions.revoked_at)));
    expect(live).toHaveLength(0);
  });
});
