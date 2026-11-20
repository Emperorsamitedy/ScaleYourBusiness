// The cutting room — Phase 3 Session C (P3-18).
//
// The owner's REAL clips: cut, captioned, cropped per platform, and —
// when a licensed track exists — scored. FFmpeg does all of it; no
// model is anywhere in this file, and there is no path that generates
// imagery. "No generated video" is not a policy note here, it is the
// absence of the capability.
//
// Music is licensed or it is not used: tracks come only from
// assets/music/manifest.json, which records the license and who holds
// it. An empty manifest (today's state — the quotes are an owner
// decision on record) refuses every music request by name.
//
// Every render is measured — wall-clock and output bytes — into the
// structured log with the account id, because compute is a cost even
// when tokens are not (P3-18: "measured and logged from the first
// render").
//
// Disclosure (rule 17) is burned into the container metadata on every
// render. There is no parameter to remove it.

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import { disclosureLabel } from "./disclosure";

const run = promisify(execFile);

export class EditError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "EditError";
    this.status = status;
  }
}

/**
 * Is the binary actually here? P3-52: a path string is not a binary — a
 * serverless bundle can carry the package's path without the file — so the
 * file must exist too. False = the honest "not available here" path.
 */
export function ffmpegAvailable(): boolean {
  return typeof ffmpegPath === "string" && ffmpegPath !== "" && existsSync(ffmpegPath);
}

function bin(): string {
  if (!ffmpegAvailable()) throw new EditError("ffmpeg is not available in this environment", 503);
  return ffmpegPath as string;
}

/* ── the licensed-music registry ── */

export interface MusicTrack {
  id: string;
  file: string;
  title: string;
  license: string;
  licensed_to: string;
}

const MUSIC_DIR = path.join(process.cwd(), "assets", "music");

export async function musicManifest(): Promise<MusicTrack[]> {
  try {
    const raw = await fs.readFile(path.join(MUSIC_DIR, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { tracks?: MusicTrack[] };
    return Array.isArray(parsed.tracks) ? parsed.tracks : [];
  } catch {
    return [];
  }
}

async function licensedTrack(trackId: string): Promise<string> {
  const tracks = await musicManifest();
  const track = tracks.find((t) => t.id === trackId);
  if (!track) {
    throw new EditError(
      `no licensed track "${trackId}" on file: the music library holds only licensed tracks, and licensing is an owner decision still open`,
      422,
    );
  }
  return path.join(MUSIC_DIR, track.file);
}

/* ── the edit ── */

export type Aspect = "vertical" | "square" | "wide";

const ASPECTS: Readonly<Record<Aspect, { w: number; h: number }>> = {
  vertical: { w: 1080, h: 1920 }, // Reels, TikTok, Shorts
  square: { w: 1080, h: 1080 }, // feed
  wide: { w: 1920, h: 1080 }, // YouTube
};

export interface ProbeResult {
  duration_s: number;
  width: number;
  height: number;
  /** P3-52: phone clips nearly always carry sound; a silent one gets silence, not a failed cut. */
  has_audio: boolean;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new EditError("no video stream in the input", 422);
  return {
    duration_s: Number.parseFloat(parsed.format?.duration ?? "0"),
    width: video.width,
    height: video.height,
    has_audio: parsed.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}

// The static ffmpeg build ships without drawtext but WITH libass, so
// captions are burned via the subtitles filter from a transient .srt —
// found by running it, not by reading the docs (build-time verification,
// the TASKS-PHASE2 discipline).
async function writeCaptionFile(output: string, caption: string): Promise<string> {
  const srt = `${output}.srt`;
  await fs.mkdir(path.dirname(srt), { recursive: true });
  await fs.writeFile(srt, `1\n00:00:00,000 --> 10:00:00,000\n${caption}\n`, "utf8");
  return srt;
}

/** Escape a path for use inside a filtergraph string. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface EditArgs {
  input: string;
  output: string;
  /** [start_s, duration_s] pairs, concatenated in order. */
  segments: readonly [number, number][];
  caption?: string;
  aspect: Aspect;
  /** id from the licensed manifest; absent = keep the clip's own audio. */
  music_track_id?: string;
  account_id: string;
}

/** P3-52: one cut from one of the owner's clips. */
export interface ClipCut {
  input: string;
  start: number;
  duration: number;
  /** From probe(); a silent clip is padded with silence so the cut still concatenates. */
  has_audio: boolean;
}

export interface EditClipsArgs {
  output: string;
  /** Cuts from one or more clips, concatenated in order. */
  cuts: readonly ClipCut[];
  caption?: string;
  aspect: Aspect;
  music_track_id?: string;
  account_id: string;
}

export interface EditResult {
  output: string;
  duration_ms: number;
  bytes: number;
  captioned: boolean;
  scored: boolean;
  disclosure: string;
}

/**
 * Cut, crop, caption and (optionally) score one clip. Real footage in,
 * real footage out — trimmed and framed, never fabricated.
 */
export async function editClip(args: EditArgs): Promise<EditResult> {
  return editClips({
    output: args.output,
    cuts: args.segments.map(([start, duration]) => ({
      input: args.input,
      start,
      duration,
      has_audio: true,
    })),
    aspect: args.aspect,
    account_id: args.account_id,
    ...(args.caption !== undefined ? { caption: args.caption } : {}),
    ...(args.music_track_id !== undefined ? { music_track_id: args.music_track_id } : {}),
  });
}

/**
 * P3-52: the same edit over several of the owner's clips — each cut framed
 * to the platform's size BEFORE the concat (phone clips differ in size and
 * frame rate), then captioned and scored once. Still real footage only.
 */
export async function editClips(args: EditClipsArgs): Promise<EditResult> {
  if (args.cuts.length === 0) throw new EditError("at least one segment is required", 422);
  const { w, h } = ASPECTS[args.aspect];
  const started = Date.now();

  const musicPath = args.music_track_id ? await licensedTrack(args.music_track_id) : null;
  const srtPath = args.caption ? await writeCaptionFile(args.output, args.caption) : null;

  // Filter graph: per-cut trim → frame → concat → caption.
  const parts: string[] = [];
  const pairs: string[] = [];
  args.cuts.forEach((cut, i) => {
    parts.push(
      `[${i}:v]trim=start=${cut.start}:duration=${cut.duration},setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30[v${i}]`,
      cut.has_audio
        ? `[${i}:a]atrim=start=${cut.start}:duration=${cut.duration},asetpts=PTS-STARTPTS,` +
            `aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
        : `anullsrc=r=44100:cl=stereo,atrim=duration=${cut.duration}[a${i}]`,
    );
    pairs.push(`[v${i}][a${i}]`);
  });
  const n = args.cuts.length;
  parts.push(`${pairs.join("")}concat=n=${n}:v=1:a=1[vcat][acat]`);
  let vchain = "[vcat]null";
  const captioned = srtPath !== null;
  if (srtPath) {
    vchain = `[vcat]subtitles='${filterPath(srtPath)}':force_style='Bold=1,Fontsize=16,PrimaryColour=&HFFFFFF&,BackColour=&H80000000&,BorderStyle=4,Alignment=2,MarginV=36'`;
  }
  parts.push(`${vchain}[vout]`);

  const inputs = args.cuts.flatMap((cut) => ["-i", cut.input]);
  let audioMap: string[];
  if (musicPath) {
    inputs.push("-i", musicPath);
    parts.push(`[${n}:a]volume=0.9[music]`);
    audioMap = ["-map", "[music]", "-shortest"];
  } else {
    audioMap = ["-map", "[acat]"];
  }

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const disclosure = disclosureLabel("video");
  try {
    await run(bin(), [
      "-y",
      ...inputs,
      "-filter_complex",
      parts.join(";"),
      "-map",
      "[vout]",
      ...audioMap,
      // Rule 17 — burned into the container on EVERY render, no flag.
      "-metadata",
      `comment=${disclosure}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      args.output,
    ]);
  } finally {
    if (srtPath) await fs.rm(srtPath, { force: true });
  }

  const stat = await fs.stat(args.output);
  const result: EditResult = {
    output: args.output,
    duration_ms: Date.now() - started,
    bytes: stat.size,
    captioned,
    scored: musicPath !== null,
    disclosure,
  };
  console.log(
    JSON.stringify({
      event: "content_render",
      account_id: args.account_id,
      aspect: args.aspect,
      segments: n,
      duration_ms: result.duration_ms,
      bytes: result.bytes,
      captioned,
      scored: result.scored,
    }),
  );
  return result;
}

/** A synthetic test clip — pattern + tone, for tests only. */
export async function makeTestClip(output: string, seconds: number): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await run(bin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=640x480:rate=30:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    output,
  ]);
}
