// Every route that runs FFmpeg or ffprobe — cutting footage, or labelling
// and reading back generated media (./generate/label) — must have the
// binaries traced into its function (next.config.ts). Without them a paid
// AI clip is made and then can't be labelled, so it is lost (P6-03: the
// studio's generate and pick were missing).

import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/** The calls that reach FFmpeg or ffprobe. */
const FFMPEG_ENTRY_POINTS =
  /\b(generateFromProposal|generateCandidatesFromProposal|collectCandidates|pickCandidate|runRender|sweepRenders)\b/;

async function routeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await routeFiles(full)));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

describe("FFmpeg reaches every route that needs it", () => {
  it("traces the binaries into each route calling a cut, a label or a read-back", async () => {
    const appDir = path.resolve(__dirname, "../../app");
    const traced = Object.keys(nextConfig.outputFileTracingIncludes ?? {});
    const needing: string[] = [];
    for (const file of await routeFiles(path.join(appDir, "api"))) {
      if (!FFMPEG_ENTRY_POINTS.test(await fs.readFile(file, "utf8"))) continue;
      const route = `/${path.relative(appDir, path.dirname(file)).split(path.sep).join("/")}`;
      needing.push(route);
    }
    expect(needing).toContain("/api/studio");
    expect(needing).toContain("/api/cron/collect-video");
    for (const route of needing) expect(traced, route).toContain(route);
  });
});
