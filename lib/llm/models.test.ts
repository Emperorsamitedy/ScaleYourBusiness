// The two model switches (M-2 prep): unset means today's models, each
// switch takes exactly its two values, and a typo fails loudly rather
// than running a model nobody chose.

import { describe, expect, it } from "vitest";
import {
  diagnosisModel,
  ModelSettingError,
  OPUS_5_5_EFFORT,
  opusShape,
  SONNET_5_5_ANSWER,
  sonnetAnswerShape,
  sonnetModel,
  thinkingOff,
} from "./models";

describe("SONNET_MODEL and DIAGNOSIS_MODEL", () => {
  it("unset or empty means today's models exactly", () => {
    expect(sonnetModel({})).toBe("claude-sonnet-5");
    expect(sonnetModel({ SONNET_MODEL: "" })).toBe("claude-sonnet-5");
    expect(sonnetModel({ SONNET_MODEL: "   " })).toBe("claude-sonnet-5");
    expect(diagnosisModel({})).toBe("claude-opus-4-8");
    expect(diagnosisModel({ DIAGNOSIS_MODEL: "" })).toBe("claude-opus-4-8");
  });

  it("takes each switch's two values, trimmed", () => {
    expect(sonnetModel({ SONNET_MODEL: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(sonnetModel({ SONNET_MODEL: " claude-sonnet-5-5 " })).toBe("claude-sonnet-5-5");
    expect(diagnosisModel({ DIAGNOSIS_MODEL: "claude-opus-4-8" })).toBe("claude-opus-4-8");
    expect(diagnosisModel({ DIAGNOSIS_MODEL: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  it("refuses anything else, naming the variable and the choices", () => {
    expect(() => sonnetModel({ SONNET_MODEL: "claude-sonnet-5.5" })).toThrow(ModelSettingError);
    expect(() => sonnetModel({ SONNET_MODEL: "claude-opus-5-5" })).toThrow(/SONNET_MODEL/);
    expect(() => diagnosisModel({ DIAGNOSIS_MODEL: "claude-opus-5" })).toThrow(
      /claude-opus-4-8, claude-opus-5-5/,
    );
  });

  it("reads process.env when no env is passed", () => {
    const before = process.env.SONNET_MODEL;
    try {
      process.env.SONNET_MODEL = "claude-sonnet-5-5";
      expect(sonnetModel()).toBe("claude-sonnet-5-5");
    } finally {
      if (before === undefined) delete process.env.SONNET_MODEL;
      else process.env.SONNET_MODEL = before;
    }
  });
});

describe("request shapes", () => {
  it("thinking off: disabled on Sonnet 5, between_tools on Sonnet 5.5", () => {
    expect(thinkingOff("claude-sonnet-5")).toStrictEqual({ type: "disabled" });
    expect(thinkingOff("claude-sonnet-5-5")).toStrictEqual({ type: "between_tools" });
  });

  it("a Sonnet answer site is untouched on Sonnet 5 and gets effort + room on 5.5", () => {
    expect(sonnetAnswerShape("chat", 400, "claude-sonnet-5")).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 400,
      effort: {},
    });
    const next = sonnetAnswerShape("chat", 400, "claude-sonnet-5-5");
    expect(next.model).toBe("claude-sonnet-5-5");
    expect(next.effort).toStrictEqual({ effort: SONNET_5_5_ANSWER.chat.effort });
    expect(next.max_tokens).toBeGreaterThan(400);
  });

  it("every 5.5 Sonnet effort is high or below, where Sonnet 5.5 accepts it", () => {
    for (const shape of Object.values(SONNET_5_5_ANSWER)) {
      expect(["low", "medium", "high"]).toContain(shape.effort);
    }
  });

  it("Opus 4.8 keeps today's shape; Opus 5.5 sends an explicit effort and doubles the cap", () => {
    expect(opusShape(8_000, "claude-opus-4-8")).toStrictEqual({
      model: "claude-opus-4-8",
      max_tokens: 8_000,
      thinking: { type: "adaptive" },
      effort: {},
    });
    expect(opusShape(8_000, "claude-opus-5-5")).toStrictEqual({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      effort: { effort: OPUS_5_5_EFFORT },
    });
    expect(OPUS_5_5_EFFORT).toBe("high"); // Opus 5.5's API default is medium: never left implicit
  });
});
