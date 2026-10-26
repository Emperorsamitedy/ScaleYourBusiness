// The FAKE media provider — P3-53. Tests and development only: the env
// switch refuses it in production (lib/env.ts mediaProviderSetting), and
// nothing it makes looks like anything but a placeholder.
//
// It behaves like a real provider where it matters to the code around it:
// a price before, a charge after, failures on demand (retryable or not,
// charged or not), and bytes back. It makes no network call.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { money } from "../../core/money";
import { ffmpegAvailable } from "../edit";
import type { GenerationRequest, GenerationOutput, MediaProvider } from "./provider";
import { GENERATED_CLIP_SECONDS, ProviderError } from "./provider";

const run = promisify(execFile);

/** A flat sage 108×135 JPEG (4:5) — unmistakably a placeholder. */
const PLACEHOLDER_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAIFEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAhgBsAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8ApwEM8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//Z",
  "base64",
);

/** The fake's price list, in euro cents — in the range real image/clip APIs quote, not a quote. */
export const FAKE_PRICES = { image: 4, video_per_second: 10, currency: "EUR" } as const;

export interface FakeOptions {
  /** Fail this many attempts before succeeding. */
  failures?: number;
  /** Whether those failures are worth retrying. */
  retryable?: boolean;
  /** Charge a failed attempt anyway (some providers do). */
  chargeFailures?: boolean;
  /** Every request, as sent — tests read the instruction off it. */
  sent?: GenerationRequest[];
}

export function fakeMediaProvider(opts: FakeOptions = {}): MediaProvider {
  let failuresLeft = opts.failures ?? 0;
  const priceOf = (media: "image" | "video", seconds = GENERATED_CLIP_SECONDS) =>
    media === "image"
      ? money(FAKE_PRICES.image, FAKE_PRICES.currency)
      : money(FAKE_PRICES.video_per_second * seconds, FAKE_PRICES.currency);
  return {
    id: "fake",
    unavailable: null,
    estimate(req) {
      return priceOf(req.media, req.seconds);
    },
    async generate(req): Promise<GenerationOutput> {
      opts.sent?.push(req);
      const cost = priceOf(req.media, req.seconds);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new ProviderError("the fake provider was told to fail", {
          retryable: opts.retryable ?? true,
          cost: opts.chargeFailures ? cost : null,
        });
      }
      if (req.media === "image") {
        return {
          bytes: new Uint8Array(PLACEHOLDER_JPEG),
          content_type: "image/jpeg",
          cost,
          model: "fake-image-1",
        };
      }
      if (!ffmpegAvailable()) {
        throw new ProviderError("the fake clip needs FFmpeg, and it isn't here");
      }
      const file = path.join(os.tmpdir(), `syb-fake-${randomBytes(8).toString("hex")}.mp4`);
      const seconds = req.seconds ?? GENERATED_CLIP_SECONDS;
      try {
        await run(ffmpegPath as string, [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=0x8fb3a0:s=1080x1920:rate=30:duration=${seconds}`,
          "-f",
          "lavfi",
          "-i",
          `anullsrc=r=44100:cl=stereo`,
          "-t",
          String(seconds),
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          file,
        ]);
        return {
          bytes: new Uint8Array(await fs.readFile(file)),
          content_type: "video/mp4",
          cost,
          model: "fake-clip-1",
        };
      } finally {
        await fs.rm(file, { force: true });
      }
    },
  };
}
