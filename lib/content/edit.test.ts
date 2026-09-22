// P3-18 — the cutting room, against real FFmpeg (the static binary the
// repo depends on). A synthetic clip goes in; what must come out: the
// right frame per platform, the requested cut length, the caption
// burned when a font exists, the disclosure in the container metadata
// with no way to omit it, and a music request refused by name while
// the licensed manifest is empty (the licensing quotes are an owner
// decision still open).

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { path as ffprobePath } from "ffprobe-static";
import { EditError, editClip, ffmpegAvailable, makeTestClip, musicManifest, probe } from "./edit";

const run = promisify(execFile);
const TMP = path.join(process.cwd(), ".data", "test-renders");

const available = ffmpegAvailable();

describe.skipIf(!available)("P3-18 — the cutting room", () => {
  it("cuts, crops to vertical, captions, and burns the disclosure into metadata", async () => {
    const input = path.join(TMP, "input.mp4");
    const output = path.join(TMP, "vertical.mp4");
    await makeTestClip(input, 4);

    const result = await editClip({
      input,
      output,
      segments: [
        [0, 1],
        [2, 1],
      ],
      caption: "Real fireplace, not perfume counter",
      aspect: "vertical",
      account_id: "test-account",
    });

    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.scored).toBe(false);

    const meta = await probe(output);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.duration_s).toBeGreaterThan(1.7);
    expect(meta.duration_s).toBeLessThan(2.6);

    // Rule 17: the disclosure is IN the file, not beside it.
    const { stdout } = await run(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format_tags=comment",
      "-print_format",
      "json",
      output,
    ]);
    const tags = JSON.parse(stdout) as { format?: { tags?: { comment?: string } } };
    expect(tags.format?.tags?.comment).toContain("AI-assisted edit of real footage");
    expect(tags.format?.tags?.comment).toContain("No AI-generated imagery");
  }, 120_000);

  it("square crop frames 1080×1080", async () => {
    const input = path.join(TMP, "input2.mp4");
    const output = path.join(TMP, "square.mp4");
    await makeTestClip(input, 2);
    await editClip({
      input,
      output,
      segments: [[0, 1.5]],
      aspect: "square",
      account_id: "test-account",
    });
    const meta = await probe(output);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
  }, 120_000);

  it("refuses to score with any track not in the licensed manifest — which is empty, on record", async () => {
    expect(await musicManifest()).toEqual([]);
    const input = path.join(TMP, "input3.mp4");
    await makeTestClip(input, 2);
    await expect(
      editClip({
        input,
        output: path.join(TMP, "scored.mp4"),
        segments: [[0, 1]],
        aspect: "wide",
        music_track_id: "warm-open-01",
        account_id: "test-account",
      }),
    ).rejects.toThrow(EditError);
    await expect(
      editClip({
        input,
        output: path.join(TMP, "scored.mp4"),
        segments: [[0, 1]],
        aspect: "wide",
        music_track_id: "warm-open-01",
        account_id: "test-account",
      }),
    ).rejects.toThrow(/no licensed track "warm-open-01" on file/);
  }, 120_000);

  it("refuses an edit with no segments", async () => {
    await expect(
      editClip({
        input: "nowhere.mp4",
        output: path.join(TMP, "none.mp4"),
        segments: [],
        aspect: "wide",
        account_id: "test-account",
      }),
    ).rejects.toThrow(/at least one segment/);
  });
});

describe("P3-18 — environment honesty", () => {
  it("states whether ffmpeg is available rather than assuming", () => {
    // On this machine the static binary is a dependency; if this fails,
    // `npm install` did not complete — a real finding, not a flake.
    expect(available).toBe(true);
  });
});
