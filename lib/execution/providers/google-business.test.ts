// I-45a lifted (2026-11-16) — the Google Business Profile executor against a
// fake Google, with the global fetch stubbed to fail if touched. No database:
// the backend is a stand-in. What it holds: the exact approved words are
// posted and nothing else; a reply someone else posted since is never
// overwritten; an hour moved by the owner since is never moved again; Google's
// dry run runs before every hours write; the stop is honoured right before a
// write; undo puts back what was there, only while SYB's change still stands;
// and a connection consented under the read-only lines writes nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGoogle } from "../../google-business/fake";
import { GOOGLE_RECONSENT } from "../../google-business/words";
import type { GoogleBusinessBackend } from "../../google-business/writes";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import type { ExecutionContext } from "./fixture";
import {
  GBP_HOURS_OP,
  GBP_REPLY_OP,
  STOPPED_BEFORE_GBP_CHANGE,
  createGoogleBusinessExecution,
  sha256,
} from "./google-business";

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterAll(() => vi.unstubAllGlobals());

const REVIEW = "accounts/111/locations/222/reviews/r1";
const CTX: ExecutionContext = { profile_id: "p1", account_id: "a1", execution_id: "e1" };

let changed: string[];
let refused: string | null;

function backend(): GoogleBusinessBackend {
  return {
    async credential() {
      if (refused) return { refused };
      return {
        access_token: "t",
        account: "accounts/111",
        location: "locations/222",
        title: "Lumen",
      };
    },
    async changed(_p, detail) {
      changed.push(detail);
    },
  };
}

beforeEach(() => {
  changed = [];
  refused = null;
});

function setup(opts: Parameters<typeof fakeGoogle>[0] = {}) {
  const g = fakeGoogle(opts);
  const exec = createGoogleBusinessExecution({ fetch: g.fetch, backend: async () => backend() });
  return { g, exec };
}

const comment =
  "Thank you for telling us — we're sorry about the wait.\n\nWritten with AI assistance.";
const replyParams = (over: Record<string, unknown> = {}) => ({
  review_name: REVIEW,
  comment,
  comment_sha256: sha256(comment),
  replaces_sha256: null,
  ...over,
});

const writes = (g: ReturnType<typeof fakeGoogle>) =>
  g.requests
    .filter((r) => r.method !== "GET")
    .map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`);

describe("I-45a lifted — the registry and the gate", () => {
  it("two ops, each reversible, and the provider is external: the real-write gate holds it", () => {
    const { exec } = setup();
    expect(EXECUTION_SCOPE_REGISTRY.google_business_reviews.operations.map((o) => o.op)).toEqual([
      GBP_REPLY_OP,
      GBP_HOURS_OP,
    ]);
    expect(exec.external).toBe(true);
  });

  it("a connection consented under the read-only lines is refused by name, before any request", async () => {
    refused = GOOGLE_RECONSENT;
    const { g, exec } = setup();
    expect(await exec.preflight!(GBP_REPLY_OP, replyParams(), CTX)).toEqual({
      code: "refused",
      message: GOOGLE_RECONSENT,
    });
    await expect(exec.execute(GBP_REPLY_OP, replyParams(), CTX)).rejects.toThrow(GOOGLE_RECONSENT);
    expect(g.requests).toEqual([]);
  });
});

describe("reply_to_review", () => {
  it("posts the approved words, once, and undo removes them", async () => {
    const { g, exec } = setup();
    expect(await exec.preflight!(GBP_REPLY_OP, replyParams(), CTX)).toBeNull();
    const undo = await exec.captureUndo(GBP_REPLY_OP, replyParams(), CTX);
    expect(undo).toEqual({ review_name: REVIEW, previous: null });
    const result = await exec.execute(GBP_REPLY_OP, replyParams(), CTX);
    expect(g.replies[REVIEW]).toBe(comment);
    expect(writes(g)).toEqual([`PUT /v4/${REVIEW}/reply`]);
    expect(changed).toEqual(["Posted your approved reply to a review on Google."]);

    await exec.undo(GBP_REPLY_OP, undo, { ...CTX, result });
    expect(g.replies[REVIEW]).toBeUndefined();
    expect(writes(g)).toEqual([`PUT /v4/${REVIEW}/reply`, `DELETE /v4/${REVIEW}/reply`]);
  });

  it("replaces the reply the owner saw when approving, and undo puts it back", async () => {
    const before = "Thanks!";
    const { g, exec } = setup({ replies: { [REVIEW]: before } });
    const params = replyParams({ replaces_sha256: sha256(before) });
    const undo = await exec.captureUndo(GBP_REPLY_OP, params, CTX);
    const result = await exec.execute(GBP_REPLY_OP, params, CTX);
    expect(g.replies[REVIEW]).toBe(comment);
    await exec.undo(GBP_REPLY_OP, undo, { ...CTX, result });
    expect(g.replies[REVIEW]).toBe(before);
  });

  it("never overwrites a reply someone posted since the approval", async () => {
    const { g, exec } = setup({ replies: { [REVIEW]: "Posted by the owner in the Google app" } });
    const pre = await exec.preflight!(GBP_REPLY_OP, replyParams(), CTX);
    expect(pre?.code).toBe("refused");
    expect(pre?.message).toMatch(/won't overwrite it/);
    await expect(exec.execute(GBP_REPLY_OP, replyParams(), CTX)).rejects.toThrow(
      /won't overwrite it/,
    );
    expect(writes(g)).toEqual([]);
  });

  it("an earlier attempt that landed is not repeated", async () => {
    const { g, exec } = setup({ replies: { [REVIEW]: comment } });
    await exec.execute(GBP_REPLY_OP, replyParams(), CTX);
    expect(writes(g)).toEqual([]);
  });

  it("words that aren't the approved ones are refused before anything is read", async () => {
    const { g, exec } = setup();
    await expect(
      exec.execute(GBP_REPLY_OP, replyParams({ comment: `${comment} PS` }), CTX),
    ).rejects.toThrow(/isn't the one you approved/);
    expect(g.requests).toEqual([]);
  });

  it("a review on another listing than the connected one is refused", async () => {
    const { g, exec } = setup();
    const other = "accounts/111/locations/999/reviews/r1";
    await expect(
      exec.execute(GBP_REPLY_OP, replyParams({ review_name: other }), CTX),
    ).rejects.toThrow(/isn't on the Google listing/);
    expect(writes(g)).toEqual([]);
  });

  it("the stop, right before the write, sends nothing", async () => {
    const { g, exec } = setup();
    await expect(
      exec.execute(GBP_REPLY_OP, replyParams(), { ...CTX, halted: async () => true }),
    ).rejects.toThrow(STOPPED_BEFORE_GBP_CHANGE);
    expect(writes(g)).toEqual([]);
  });

  it("undo refuses when the reply on Google isn't SYB's any more", async () => {
    const { g, exec } = setup();
    const undo = await exec.captureUndo(GBP_REPLY_OP, replyParams(), CTX);
    const result = await exec.execute(GBP_REPLY_OP, replyParams(), CTX);
    g.replies[REVIEW] = "Edited by the owner";
    await expect(exec.undo(GBP_REPLY_OP, undo, { ...CTX, result })).rejects.toThrow(
      /won't override that/,
    );
    expect(g.replies[REVIEW]).toBe("Edited by the owner");
  });

  it("a quota answer is retryable; a refusal is not", async () => {
    const busy = setup({ writeStatus: 429 });
    await expect(busy.exec.execute(GBP_REPLY_OP, replyParams(), CTX)).rejects.toMatchObject({
      retryable: true,
    });
    const no = setup({ writeStatus: 400 });
    await expect(no.exec.execute(GBP_REPLY_OP, replyParams(), CTX)).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe("set_regular_hours", () => {
  const FRIDAY = [
    { openDay: "FRIDAY", openTime: { hours: 9 }, closeDay: "FRIDAY", closeTime: { hours: 17 } },
  ];
  const params = { location: "locations/222", weekday: "fri", edge: "open", from: 540, to: 480 };

  it("moves the one opening time, Google's dry run first, and undo moves it back", async () => {
    const { g, exec } = setup({ hours: { "locations/222": FRIDAY } });
    expect(await exec.preflight!(GBP_HOURS_OP, params, CTX)).toBeNull();
    const undo = await exec.captureUndo(GBP_HOURS_OP, params, CTX);
    const result = await exec.execute(GBP_HOURS_OP, params, CTX);
    expect(g.hours["locations/222"]).toEqual([
      { openDay: "FRIDAY", openTime: { hours: 8 }, closeDay: "FRIDAY", closeTime: { hours: 17 } },
    ]);
    expect(writes(g)).toEqual([
      "PATCH /v1/locations/222?updateMask=regularHours&validateOnly=true",
      "PATCH /v1/locations/222?updateMask=regularHours",
    ]);
    expect(changed).toEqual([
      "Changed your Google listing's opening time on Fridays from 09:00 to 08:00.",
    ]);
    await exec.undo(GBP_HOURS_OP, undo, { ...CTX, result });
    expect(g.hours["locations/222"]).toEqual([
      { openDay: "FRIDAY", openTime: { hours: 9 }, closeDay: "FRIDAY", closeTime: { hours: 17 } },
    ]);
  });

  it("refuses when the owner's hours on Google have moved since the approval", async () => {
    const moved = [
      { openDay: "FRIDAY", openTime: { hours: 10 }, closeDay: "FRIDAY", closeTime: { hours: 17 } },
    ];
    const { g, exec } = setup({ hours: { "locations/222": moved } });
    expect((await exec.preflight!(GBP_HOURS_OP, params, CTX))?.code).toBe("refused");
    await expect(exec.execute(GBP_HOURS_OP, params, CTX)).rejects.toThrow(/moved since/);
    expect(writes(g)).toEqual([]);
  });

  it("undo refuses when the owner moved the hour again since", async () => {
    const { g, exec } = setup({ hours: { "locations/222": FRIDAY } });
    const undo = await exec.captureUndo(GBP_HOURS_OP, params, CTX);
    const result = await exec.execute(GBP_HOURS_OP, params, CTX);
    g.hours["locations/222"] = [
      { openDay: "FRIDAY", openTime: { hours: 7 }, closeDay: "FRIDAY", closeTime: { hours: 17 } },
    ];
    await expect(exec.undo(GBP_HOURS_OP, undo, { ...CTX, result })).rejects.toThrow(
      /won't override that/,
    );
  });

  it("the stop between the dry run and the change sends no change", async () => {
    const { g, exec } = setup({ hours: { "locations/222": FRIDAY } });
    await expect(
      exec.execute(GBP_HOURS_OP, params, { ...CTX, halted: async () => true }),
    ).rejects.toThrow(STOPPED_BEFORE_GBP_CHANGE);
    expect(writes(g)).toEqual([
      "PATCH /v1/locations/222?updateMask=regularHours&validateOnly=true",
    ]);
    expect(g.hours["locations/222"]).toEqual(FRIDAY);
  });

  it("a listing other than the connected one is refused", async () => {
    const { g, exec } = setup({ hours: { "locations/222": FRIDAY } });
    await expect(
      exec.execute(GBP_HOURS_OP, { ...params, location: "locations/999" }, CTX),
    ).rejects.toThrow(/different listing/);
    expect(g.requests).toEqual([]);
  });
});
