// P3-24a — every Meta refusal maps once to a sentence, a connection state,
// a next step and a retry decision. Every mapping is a test.

import { describe, expect, it } from "vitest";
import { classifyMetaError } from "./meta-errors";

const c = (code: number | null, subcode: number | null = null, status = 400) =>
  classifyMetaError({ status, code, subcode });

describe("P3-24a — the Meta error taxonomy", () => {
  it("auth 102 and 190 pause the connection and ask for a reconnect — never retried", () => {
    for (const code of [102, 190]) {
      expect(c(code)).toMatchObject({
        kind: "auth",
        connection_state: "paused",
        next_step: "reconnect",
        retryable: false,
      });
    }
    expect(c(190).owner_sentence).toBe(
      "I couldn't reach Meta: the connection's sign-in expired or was revoked. Reconnect it on Connections and I'll pick up where I left off.",
    );
  });

  it("190's subcodes say why, in the owner's words", () => {
    expect(c(190, 463).owner_sentence).toMatch(/sign-in expired\./);
    expect(c(190, 460).owner_sentence).toMatch(/password changed/);
    expect(c(190, 458).owner_sentence).toMatch(/app was removed/);
    expect(c(190, 467).owner_sentence).toMatch(/no longer valid/);
    expect(c(190, 999).owner_sentence).toMatch(/expired or was revoked/); // an unknown subcode: the general reason
  });

  it("permission 10, 200, 294 and 100/33 pause and ask for the listed permissions", () => {
    for (const [code, sub] of [
      [10, null],
      [200, null],
      [294, null],
      [100, 33],
    ] as const) {
      expect(c(code, sub)).toMatchObject({
        kind: "permission",
        connection_state: "paused",
        next_step: "reconnect",
        retryable: false,
      });
    }
    // 100 without subcode 33 is not a permission problem.
    expect(c(100).kind).toBe("unknown");
  });

  it("rate limits 4, 17, 32, 613 and HTTP 429 keep the connection and wait", () => {
    for (const code of [4, 17, 32, 613]) {
      expect(c(code)).toMatchObject({
        kind: "rate_limit",
        connection_state: "connected",
        next_step: "wait",
        retryable: true,
      });
    }
    expect(c(null, null, 429).kind).toBe("rate_limit");
  });

  it("80001, the Page business-use-case limit, is its own sentence", () => {
    expect(c(80001)).toMatchObject({
      kind: "page_limit",
      retryable: true,
      connection_state: "connected",
    });
    expect(c(80001).owner_sentence).toMatch(/limit for this Page/);
  });

  it("no answer, a 5xx, or Meta's temporary codes 1 and 2 are retried, saying nothing was published", () => {
    for (const f of [c(null, null, 0), c(null, null, 502), c(1), c(2)]) {
      expect(f).toMatchObject({
        kind: "unavailable",
        retryable: true,
        connection_state: "connected",
      });
      expect(f.owner_sentence).toMatch(/Nothing was published/);
    }
  });

  it("anything else gets the honest default, with its code, and is not retried", () => {
    expect(c(368)).toEqual({
      kind: "unknown",
      code: 368,
      subcode: null,
      owner_sentence: "Meta refused with code 368; nothing was published.",
      connection_state: "connected",
      next_step: "check_item",
      retryable: false,
    });
    expect(c(null, null, 418).owner_sentence).toBe(
      "Meta refused with status 418; nothing was published.",
    );
  });

  it("an ad change says nothing was changed, never published (P3-22b); a publish keeps its wording", () => {
    const ad = (code: number | null, status = 400) =>
      classifyMetaError({ status, code, subject: "ad_change" });
    expect(ad(368).owner_sentence).toBe("Meta refused with code 368; nothing was changed.");
    expect(ad(null, 0).owner_sentence).toMatch(/Nothing was changed — I'll try again/);
    expect(ad(190).kind).toBe("auth"); // the mapping itself is unchanged
    expect(classifyMetaError({ status: 400, code: 368, subject: "publish" }).owner_sentence).toBe(
      "Meta refused with code 368; nothing was published.",
    );
  });

  it("never pauses for something waiting can fix, and never retries something the owner must fix", () => {
    const all = [102, 190, 10, 200, 294, 4, 17, 32, 613, 80001, 1, 2, 368].map((code) => c(code));
    for (const f of all) {
      if (f.connection_state === "paused") expect(f.retryable).toBe(false);
      if (f.retryable) expect(f.next_step).toBe("wait");
    }
  });
});
