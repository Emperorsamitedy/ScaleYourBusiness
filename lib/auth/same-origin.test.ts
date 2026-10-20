// Login CSRF: only a POST from our own page may sign a browser in.

import { describe, expect, it } from "vitest";
import { isSameOriginPost } from "./same-origin";

const APP = "https://app.example";

function h(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("isSameOriginPost — a cross-site form can't sign anyone in", () => {
  it("accepts our own page's POST, by Sec-Fetch-Site or by Origin", () => {
    expect(isSameOriginPost(h({ "sec-fetch-site": "same-origin" }), APP)).toBe(true);
    expect(isSameOriginPost(h({ origin: APP }), APP)).toBe(true);
    expect(isSameOriginPost(h({ origin: `${APP}/` }), APP)).toBe(true);
  });

  it("refuses an attacker's auto-submitting form, however it is labelled", () => {
    expect(isSameOriginPost(h({ "sec-fetch-site": "cross-site" }), APP)).toBe(false);
    expect(isSameOriginPost(h({ "sec-fetch-site": "same-site" }), APP)).toBe(false);
    expect(isSameOriginPost(h({ "sec-fetch-site": "none" }), APP)).toBe(false);
    expect(isSameOriginPost(h({ origin: "https://evil.example" }), APP)).toBe(false);
    // Sec-Fetch-Site outranks a forged-looking Origin.
    expect(isSameOriginPost(h({ "sec-fetch-site": "cross-site", origin: APP }), APP)).toBe(false);
  });

  it("refuses a POST that proves nothing about where it came from", () => {
    expect(isSameOriginPost(h({}), APP)).toBe(false);
    expect(isSameOriginPost(h({ origin: "null" }), APP)).toBe(false);
  });
});
