// The fixture site executor — Session F's proving ground. An in-repo
// "website" (url → html) standing in for a platform with a theme API,
// so preview → approve → apply → health-check → undo/auto-rollback is
// proven end to end before any real platform write exists (which stays
// behind the Session D gate, like every external write).
//
// The undo payload is the ENTIRE previous page — undo months later
// restores it byte for byte, whatever else the fixture "site" claims
// by then (rule 16: permanent, not a window).

import type { ExecutionProvider } from "./fixture";

const pages = new Map<string, string>();
let failNextApplies = 0;

export const fixtureSiteExecutor: ExecutionProvider = {
  id: "fixture_site",

  async captureUndo(op, params) {
    if (op !== "apply_site_change") return null;
    const url = String(params.url);
    return { url, previous_html: pages.get(url) ?? null };
  },

  async execute(op, params) {
    if (op !== "apply_site_change") throw new Error(`fixture_site: unknown op "${op}"`);
    if (failNextApplies > 0) {
      failNextApplies -= 1;
      throw new Error("fixture_site: injected apply failure");
    }
    const url = String(params.url);
    const html = String(params.next_html);
    pages.set(url, html);
    return { applied: url, bytes: html.length };
  },

  async undo(op, undoPayload) {
    if (op !== "apply_site_change") throw new Error(`fixture_site: "${op}" has no undo`);
    const { url, previous_html } = undoPayload as { url: string; previous_html: string | null };
    if (previous_html === null) pages.delete(url);
    else pages.set(url, previous_html);
    return { restored: url };
  },
};

/* ── test hooks ── */

export function fixtureSiteSet(url: string, html: string): void {
  pages.set(url, html);
}

export function fixtureSiteRead(url: string): string | undefined {
  return pages.get(url);
}

export function fixtureSiteFailNextApplies(n: number): void {
  failNextApplies = n;
}

export function fixtureSiteReset(): void {
  pages.clear();
  failNextApplies = 0;
}
