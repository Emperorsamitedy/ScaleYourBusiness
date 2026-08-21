import { describe, expect, it } from "vitest";
import { CONFIDENCE_BASE } from "./confidence";

describe("CONFIDENCE_BASE — conversation-channel.md §2.3", () => {
  it("carries the three §2.3 base values exactly", () => {
    expect(CONFIDENCE_BASE.owner_input_precise).toBe(0.75);
    expect(CONFIDENCE_BASE.conversation_confirmed).toBe(0.7);
    expect(CONFIDENCE_BASE.conversation_unconfirmed).toBe(0.45);
  });

  it("orders conversation below structured input — confirmed and especially unconfirmed", () => {
    const { owner_input_precise, conversation_confirmed, conversation_unconfirmed } =
      CONFIDENCE_BASE;
    expect(conversation_confirmed).toBeLessThan(owner_input_precise);
    expect(conversation_unconfirmed).toBeLessThan(conversation_confirmed);
  });

  it("keeps an unconfirmed extraction below the 0.5 web-research floor of §8.1 — it can never silently outrank a researched or structured value", () => {
    expect(CONFIDENCE_BASE.conversation_unconfirmed).toBeLessThan(0.5);
  });
});
