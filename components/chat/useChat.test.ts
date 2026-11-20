// The line that stands where a reply did not come, and asking again
// (components/chat/useChat.ts).

import { describe, expect, it } from "vitest";
import type { Turn } from "./chat-view";
import { canRetry, failureLine, isFailure, withoutFailed } from "./useChat";

const failed = "Something went wrong on my side. Say that again?";

describe("the line shown when a message got no reply", () => {
  it("keeps a refusal's own reason", () => {
    expect(failureLine(422, "that message is too long", failed)).toBe("that message is too long");
    expect(
      failureLine(503, "I can't answer from here yet — this server's KEY isn't set.", failed),
    ).toBe("I can't answer from here yet — this server's KEY isn't set.");
  });

  it("says it in the reader's words for a plain 500, no answer at all, or an empty reason", () => {
    expect(failureLine(500, "something went wrong on our side", failed)).toBe(failed);
    expect(failureLine(null, null, failed)).toBe(failed);
    expect(failureLine(422, null, failed)).toBe(failed);
    expect(failureLine(403, "  ", failed)).toBe(failed);
  });
});

const turn = (id: string, role: Turn["role"], text = "x"): Turn => ({
  id,
  role,
  text,
  at: "2026-11-20T08:00:00.000Z",
  intent: null,
});

describe("asking again", () => {
  it("is offered when the server failed or never answered", () => {
    expect(canRetry(null)).toBe(true);
    expect(canRetry(500)).toBe(true);
    expect(canRetry(502)).toBe(true);
    expect(canRetry(504)).toBe(true);
  });

  it("is not offered for a refusal that gave its reason: it would give it again", () => {
    expect(canRetry(422)).toBe(false); // too long
    expect(canRetry(429)).toBe(false); // the plan's allowance is used up
    expect(canRetry(403)).toBe(false); // not this role's to ask
    expect(canRetry(401)).toBe(false); // signed out
    expect(canRetry(503)).toBe(false); // a key this server lacks
    expect(canRetry(200)).toBe(false);
  });

  it("knows the line that stands for a missing reply from a reply", () => {
    expect(isFailure(turn("err-1763625600000", "system"))).toBe(true);
    expect(isFailure(turn("0d0c4f3e-reply", "system"))).toBe(false);
    expect(isFailure(turn("tmp-1763625600000", "owner"))).toBe(false);
  });

  it("takes the failed exchange off the screen, so the question shows once", () => {
    const kept = [turn("a", "owner", "first"), turn("b", "system", "an answer")];
    const thread = [...kept, turn("tmp-1", "owner", "second"), turn("err-2", "system", failed)];
    expect(withoutFailed(thread)).toEqual(kept);
  });

  it("leaves a thread that did not just fail as it is, and a stored question in place", () => {
    const fine = [turn("a", "owner"), turn("b", "system")];
    expect(withoutFailed(fine)).toEqual(fine);
    expect(withoutFailed([])).toEqual([]);
    // The question before the failure line is the server's own row, not the
    // screen's: only the line goes.
    const stored = [turn("a", "owner", "asked"), turn("err-2", "system", failed)];
    expect(withoutFailed(stored)).toEqual([turn("a", "owner", "asked")]);
  });
});
