import { describe, expect, it } from "vitest";
import type { IntakeChip } from "@/lib/intake/types";
import { beat, parseCssMs } from "./motion";
import {
  factLine,
  keyHint,
  parseProvenance,
  recordSummary,
  sessionTally,
  tallyText,
} from "./record";

const chip = (provenance: string, display = "30 days"): IntakeChip => ({
  question_id: "4.2",
  prompt: "How long is your returns window?",
  display,
  provenance,
  dot: provenance.includes("owner") ? "solid" : "hollow",
});

describe("intake record — fact lines", () => {
  it("reads a stated answer as a recorded fact with its source", () => {
    const line = factLine(chip("4.2 · owner · stated"));
    expect(line.flag).toBe("RECORDED");
    expect(line.ref).toBe("4.2");
    expect(line.value).toBe("30 days");
    expect(line.source).toBe("Source: you · stated");
    expect(line.followUp).toBeNull();
  });

  it("marks an estimate as an estimate, not a stated fact", () => {
    const line = factLine(chip("4.2 · owner · estimate"));
    expect(line.flag).toBe("ESTIMATE");
    expect(line.source).toBe("Source: you · estimate");
  });

  it("keeps unknown and skipped distinct (rule 5)", () => {
    const gap = factLine(chip("4.2 · gap · will revisit", "Not known"));
    const skip = factLine(chip("4.2 · skipped · will return", "Skipped for now"));
    expect(gap.kind).toBe("unknown");
    expect(gap.flag).toBe("GAP RECORDED");
    expect(gap.followUp).not.toBeNull();
    expect(skip.kind).toBe("skipped");
    expect(skip.value).toBe("Not provided");
    expect(skip.flag).not.toBe(gap.flag);
  });

  it("does not mistake a stated value for a gap", () => {
    expect(parseProvenance("1.1 · owner · stated").kind).toBe("stated");
    expect(parseProvenance("1.1 · owner · stated").kind).not.toBe("unknown");
    expect(parseProvenance("1.1 · reopened").kind).toBe("reopened");
  });
});

describe("intake record — progress in words", () => {
  it("states what is on record and what is open, never a fraction", () => {
    const text = recordSummary({ core_done: 6, core_total: 12, fraction: 0.5 });
    expect(text).toBe("6 core facts on record · 6 core questions open");
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it("uses the singular and says when nothing is open", () => {
    expect(recordSummary({ core_done: 1, core_total: 2, fraction: 0.5 })).toBe(
      "1 core fact on record · 1 core question open",
    );
    expect(recordSummary({ core_done: 12, core_total: 12, fraction: 1 })).toBe(
      "12 core facts on record · no core questions open",
    );
  });

  it("tallies the session by kind and leaves zero parts out", () => {
    const t = sessionTally([
      chip("1.1 · owner · stated"),
      chip("1.2 · owner · estimate"),
      chip("1.3 · gap · will revisit"),
      chip("1.4 · skipped · will return"),
    ]);
    expect(t).toEqual({ recorded: 2, gaps: 1, notProvided: 1 });
    expect(tallyText(t)).toBe("2 recorded · 1 gap · 1 not provided");
    expect(tallyText({ recorded: 3, gaps: 0, notProvided: 0 })).toBe("3 recorded");
  });
});

describe("intake key hints", () => {
  it("names keys in words, never glyphs", () => {
    expect(keyHint("long_text", true)).toBe("Cmd + Enter to record");
    expect(keyHint("long_text", false)).toBe("Ctrl + Enter to record");
    expect(keyHint("money", false)).toBe("Enter to record");
    expect(keyHint("single_select", false)).toBeNull();
    for (const t of ["long_text", "text", "number", "money", "date", "entity_list"] as const) {
      expect(keyHint(t, true)).not.toMatch(/[↩⌘⏎]/);
    }
  });
});

describe("intake motion timing", () => {
  it("parses the CSS duration token the depart animation uses", () => {
    expect(parseCssMs("280ms")).toBe(280);
    expect(parseCssMs(" 0.3s ")).toBe(300);
    expect(parseCssMs("0ms")).toBe(0);
    expect(parseCssMs("")).toBeNull();
    expect(parseCssMs("fast")).toBeNull();
  });

  it("collapses every beat to zero under reduced motion", () => {
    expect(beat(130, false)).toBe(130);
    expect(beat(130, true)).toBe(0);
  });
});
