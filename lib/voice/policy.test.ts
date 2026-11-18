// Idea 50: the microphone only works if the site's own Permissions-Policy
// lets the page ask for it. The header said "microphone=()" until
// 2026-11-18, which refused the feature for every page before the browser
// could show its prompt: the owner pressed the microphone and nothing
// happened. This holds the header to the page's own origin, and to nothing
// wider.

import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

async function permissionsPolicy(): Promise<string> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const everywhere = rules.find((r) => r.source === "/(.*)");
  const header = everywhere?.headers.find((h) => h.key === "Permissions-Policy");
  if (!header) throw new Error("no Permissions-Policy on every route");
  return header.value;
}

/** The allowlist a feature is given, e.g. "(self)", or null when it is not named. */
function allowlist(policy: string, feature: string): string | null {
  for (const part of policy.split(",")) {
    const [name, value] = part.trim().split("=");
    if (name === feature) return value ?? "";
  }
  return null;
}

describe("the site's Permissions-Policy and the microphone", () => {
  it("lets the page's own origin ask for the microphone", async () => {
    expect(allowlist(await permissionsPolicy(), "microphone")).toBe("(self)");
  });

  it("does not let every origin use it, and does not refuse it outright", async () => {
    const mic = allowlist(await permissionsPolicy(), "microphone");
    expect(mic).not.toBe("()");
    expect(mic).not.toContain("*");
  });

  it("keeps the camera, location and payment off for everyone", async () => {
    const policy = await permissionsPolicy();
    for (const feature of ["camera", "geolocation", "payment"]) {
      expect(allowlist(policy, feature), feature).toBe("()");
    }
  });
});
