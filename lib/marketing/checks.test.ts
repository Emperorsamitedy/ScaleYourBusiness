import "dotenv/config";
import { describe, expect, it } from "vitest";
import { RULES } from "../validation/rules";
import { AREAS } from "../diagnosis/findings";
import { CHECKS, CHECK_AREAS } from "./checks";

// The landing page prints these counts; they must stay true to the code.
describe("the checks the landing page claims", () => {
  it("lists every validation rule the product runs", () => {
    const listed = new Set(CHECKS.map((c) => c.source));
    for (const rule of RULES) expect(listed, rule.id).toContain(rule.id);
  });

  it("names no rule that does not exist", () => {
    const ruleIds = new Set(RULES.map((r) => r.id));
    for (const c of CHECKS.filter((c) => c.kind === "consistency")) {
      expect(ruleIds, c.source).toContain(c.source);
    }
  });

  it("uses only the diagnosis's own areas", () => {
    for (const a of CHECK_AREAS) expect(AREAS).toContain(a);
  });
});
