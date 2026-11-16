// I-45a — the Google consent's routes, as real requests through the real
// door (only next/headers' cookie jar is stood in). Granting and revoking
// are an owner's alone (write_access.manage, lib/auth/role-actions): a
// manager is refused at every step, and nothing is sent to Google.
// Unconfigured, the screen says so and the start refuses.

import "dotenv/config";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../../../../lib/auth/access";
import type { Role } from "../../../../lib/auth/roles";
import { roleAllows } from "../../../../lib/auth/roles";
import { openSession } from "../../../../lib/auth/service";
import { bootstrapIntake } from "../../../../lib/intake/service";

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

const { GET, DELETE } = await import("./route");
const { POST: startPOST } = await import("./start/route");
const { POST: finishPOST } = await import("./finish/route");
const { GET: callbackGET } = await import("./callback/route");

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_BUSINESS_API_APPROVED"];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function arm(on: boolean) {
  if (on) {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_BUSINESS_API_APPROVED = "true";
  } else {
    delete process.env.GOOGLE_BUSINESS_API_APPROVED;
  }
}

async function member(role: Role) {
  const boot = await bootstrapIntake();
  // An account always keeps an owner: the owner first, then the person signed in.
  const add = async (r: Role) => {
    const [u] = await db
      .insert(users)
      .values({
        account_id: boot.account_id,
        email: `gbp-${r}-${crypto.randomUUID().slice(0, 8)}@example.com`,
        display_name: "gbp",
        role: r,
      })
      .returning();
    if (!u) throw new Error("fixture user");
    return u;
  };
  const owner = await add("owner");
  const u = role === "owner" ? owner : await add(role);
  const s = await openSession(u);
  jar.clear();
  jar.set(AUTH_COOKIE, s.session_token);
  jar.set(INTAKE_COOKIE, signProfileCookie(boot.profile_id));
  return boot;
}

const form = (url: string, fields: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams(fields).toString(),
  });

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

describe("I-45a — who may grant", () => {
  it("the rule: write_access.manage is an owner's, not a manager's or a viewer's", () => {
    expect(roleAllows("owner", "write_access.manage")).toBe(true);
    expect(roleAllows("manager", "write_access.manage")).toBe(false);
    expect(roleAllows("viewer", "write_access.manage")).toBe(false);
  });

  it("a manager is refused at the start, the callback, the pick and the revoke — nothing goes to Google", async () => {
    arm(true);
    await member("manager");
    const start = await startPOST(
      form("/api/connections/google-business/start", { confirmation: "allow replies and hours" }),
    );
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toBe(
      "http://localhost:3000/connections?google=error&reason=owner_only",
    );
    const back = await callbackGET(
      new NextRequest(
        "http://localhost:3000/api/connections/google-business/callback?code=c&state=s",
      ),
    );
    expect(back.headers.get("location")).toContain("reason=owner_only");
    expect(
      (await finishPOST(json("/api/connections/google-business/finish", "POST", { location: "x" })))
        .status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          json("/api/connections/google-business", "DELETE", { id: crypto.randomUUID() }),
        )
      ).status,
    ).toBe(403);
  });

  it("an owner who typed the phrase is sent to Google's consent screen, for the one scope", async () => {
    arm(true);
    await member("owner");
    const res = await startPOST(
      form("/api/connections/google-business/start", { confirmation: "allow replies and hours" }),
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/business.manage");
    expect(res.cookies.get("syb_google_business_nonce")?.value).toBeTruthy();
  });

  it("an owner who didn't type it, or a post from another site, is sent back with nothing sent", async () => {
    arm(true);
    await member("owner");
    const wrong = await startPOST(
      form("/api/connections/google-business/start", { confirmation: "ok" }),
    );
    expect(wrong.headers.get("location")).toContain("reason=phrase");
    const cross = await startPOST(
      new NextRequest("http://localhost:3000/api/connections/google-business/start", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body: "confirmation=allow+reading+reviews",
      }),
    );
    expect(cross.headers.get("location")).toContain("reason=start_here");
  });
});

describe("I-45a — unconfigured", () => {
  it("the screen says it isn't set up yet, and the start refuses", async () => {
    arm(false);
    await member("owner");
    const view = (await (
      await GET(new NextRequest("http://localhost:3000/api/connections/google-business"))
    ).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ configured: false, connection: null, pick: null });
    expect(String(view.not_set_up)).toMatch(/^Not set up yet\./);
    expect(String(view.what_it_can_do)).toMatch(
      /can also post replies to your reviews and edit your Business Profile listing\. ScaleX reads your reviews with it, and posts a reply or changes your opening hours only after you approve that exact change\. You can revoke it any time\./,
    );
    const res = await startPOST(
      form("/api/connections/google-business/start", { confirmation: "allow replies and hours" }),
    );
    expect(res.headers.get("location")).toContain("reason=unavailable");
  });
});
