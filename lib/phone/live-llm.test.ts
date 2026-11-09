// Review 2026-11-08: the live phone turn fits inside Twilio's webhook
// timeout. Twilio waits about fifteen seconds for a voice webhook; an
// eight-second model timeout with one SDK retry could take sixteen and
// more, and the caller would hear Twilio's application error instead of the
// line taking a message. No network, no database: the client is a fake.

import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CostLog from "../llm/cost-log";

const create = vi.fn();

vi.mock("../llm/client", () => ({
  anthropicClient: () => ({ messages: { create } }),
}));
vi.mock("../llm/cost-log", async (importOriginal) => {
  const real = await importOriginal<typeof CostLog>();
  return { ...real, recordLlmCall: vi.fn(async () => undefined) };
});

import {
  PHONE_MODEL_MAX_RETRIES,
  PHONE_MODEL_TIMEOUT_MS,
  TWILIO_WEBHOOK_TIMEOUT_MS,
  livePhoneLlm,
} from "./line";

afterEach(() => create.mockReset());

describe("the live phone turn's time budget", () => {
  it("asks the SDK for every attempt together to fit inside Twilio's webhook timeout", async () => {
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"action":"take_message","answer":"","used":[]}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await livePhoneLlm({
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      accountId: "00000000-0000-4000-8000-000000000000",
    });
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0]![1] as { timeout: number; maxRetries: number };
    expect(options.timeout).toBe(PHONE_MODEL_TIMEOUT_MS);
    expect(options.maxRetries).toBe(PHONE_MODEL_MAX_RETRIES);
    // Every attempt at its full timeout, plus a second of the route's own work.
    const worst = options.timeout * (options.maxRetries + 1) + 1_000;
    expect(worst).toBeLessThan(TWILIO_WEBHOOK_TIMEOUT_MS);
  });
});
