// Review 2026-10-23 (#24) — the owner's support API refuses a cross-site
// POST before it reads anything; the widget's public route stays open to
// the owner's website. No session here: a request that gets past the
// origin check answers 401 (no intake cookie), which is how the passing
// case shows it got past.

import "dotenv/config";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// No request scope in a test: an empty cookie store, so resolveAccess finds no session.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

const APP = "http://localhost:3000";
const savedAppUrl = process.env.APP_URL;
beforeAll(() => {
  process.env.APP_URL = APP;
});
afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

function post(path: string, headers: Record<string, string>, body: unknown = { action: "rotate" }) {
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("review #24 — /api/support POST is same-origin only", () => {
  it("a cross-site POST, or one with no provenance at all, is refused with 403 before any read", async () => {
    const { POST } = await import("../../app/api/support/route");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const headers of [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
        { origin: "https://evil.example" },
        {},
      ]) {
        const res = await POST(post("/api/support", headers));
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("the passing case: a same-origin POST gets past the check (and, signed out, is a 401)", async () => {
    const { POST } = await import("../../app/api/support/route");
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: APP }]) {
      const res = await POST(post("/api/support", headers));
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
  });

  it("the widget's public route still answers a cross-site POST from the owner's website", async () => {
    const { POST } = await import("../../app/api/support/public/route");
    const res = await POST(
      post(
        "/api/support/public",
        { "sec-fetch-site": "cross-site", origin: "https://shop.example" },
        { action: "nothing" },
      ),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
