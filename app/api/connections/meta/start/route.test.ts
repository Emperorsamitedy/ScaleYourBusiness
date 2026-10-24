// Review 2026-10-23, Session D #8 — the Facebook Login start is POST-only and
// must prove it came from SYB's own page. The session lookup is stubbed (it
// reads request cookies): reaching it at all is what proves a start passed
// the origin check; refused starts never reach it. Nothing is sent to Meta —
// the global fetch fails the test if touched.

import "dotenv/config";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAccess = vi.fn(async () => null);
vi.mock("../../../../../lib/auth/access", () => ({ resolveAccess }));

const { GET, POST } = await import("./route");

const ORIGIN = "https://syb.test";
const realFetch = vi.fn(async () => {
  throw new Error("a real fetch was attempted in the Meta start test");
});
const appUrlBefore = process.env.APP_URL;
beforeAll(() => {
  vi.stubGlobal("fetch", realFetch);
  process.env.APP_URL = ORIGIN;
});
afterAll(() => {
  expect(realFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (appUrlBefore === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrlBefore;
});
beforeEach(() => resolveAccess.mockClear());

function post(headers: Record<string, string>): NextRequest {
  return new NextRequest(`${ORIGIN}/api/connections/meta/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ provider: "meta_publish", confirmation: "allow publishing" }),
  });
}

const reasonOf = (res: Response) =>
  new URL(res.headers.get("location") ?? "", ORIGIN).searchParams.get("reason");

describe("Review D #8 — Facebook Login starts only from a same-origin POST", () => {
  it("THE ATTACK: a GET link — even one carrying the phrase — starts nothing and goes back to the button", async () => {
    const res = await GET(
      new NextRequest(
        `${ORIGIN}/api/connections/meta/start?provider=meta_publish&confirmation=allow+publishing`,
      ),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/connections");
    expect(reasonOf(res)).toBe("start_here");
    expect(res.headers.get("location")).not.toContain("facebook.com");
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("THE ATTACK: a POST with neither Sec-Fetch-Site nor Origin, or from another site, is refused", async () => {
    for (const headers of [
      {},
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { origin: "https://evil.test" },
    ]) {
      const res = await POST(post(headers));
      expect(res.status, JSON.stringify(headers)).toBe(303);
      expect(reasonOf(res)).toBe("start_here");
    }
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("the control: a same-origin POST (by Sec-Fetch-Site, or by Origin) goes on to the session check", async () => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: ORIGIN }]) {
      const res = await POST(post(headers));
      expect(reasonOf(res)).toBe("signed_out"); // no session in this test: past the origin check
    }
    expect(resolveAccess).toHaveBeenCalledTimes(2);
  });
});
