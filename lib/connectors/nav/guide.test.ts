// The NAV guide's gate (the multi-market spec §E.4): it goes live only when
// every step has its real screenshot. The gate is tested here against a
// scratch folder, so the suite stays green while the owner's screenshots
// are on their way — /ops lists the empty slots meanwhile.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_GUIDE_DIR, NAV_GUIDE_STEPS, navGuideMissing, navGuideReady } from "./guide";

describe("§E.4 — the Hungarian guide and its screenshot slots", () => {
  it("has a Hungarian step for each slot, and never asks for the exchange key", () => {
    expect(NAV_GUIDE_STEPS).toHaveLength(6);
    for (const s of NAV_GUIDE_STEPS) expect(s.hu.length).toBeGreaterThan(10);
    expect(NAV_GUIDE_STEPS.find((s) => s.image === "step-4-rights.png")?.hu).toMatch(
      /CSAK a Számlák lekérdezése/,
    );
    expect(NAV_GUIDE_STEPS.find((s) => s.image === "step-5-keys.png")?.hu).toMatch(/soha nem kéri/);
  });

  it("refuses to go live while any slot is empty, and names the empty ones", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nav-guide-"));
    mkdirSync(path.join(root, NAV_GUIDE_DIR), { recursive: true });
    expect(navGuideReady(root)).toBe(false);
    for (const s of NAV_GUIDE_STEPS.slice(0, 5))
      writeFileSync(path.join(root, NAV_GUIDE_DIR, s.image), "png");
    expect(navGuideMissing(root)).toEqual(["step-6-done.png"]);
    writeFileSync(path.join(root, NAV_GUIDE_DIR, "step-6-done.png"), "png");
    expect(navGuideReady(root)).toBe(true);
  });

  it("the slots match the list the owner was given", () => {
    const readme = readFileSync(path.join(process.cwd(), NAV_GUIDE_DIR, "README.md"), "utf8");
    for (const s of NAV_GUIDE_STEPS) expect(readme).toContain(s.image);
  });
});
