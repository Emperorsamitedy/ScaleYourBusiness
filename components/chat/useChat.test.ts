// The line that stands where a reply did not come (components/chat/useChat.ts).

import { describe, expect, it } from "vitest";
import { failureLine } from "./useChat";

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
