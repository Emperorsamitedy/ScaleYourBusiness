// Higgsfield's API as a MediaProvider — P6-03 (Phase 6, rules 33 and 34).
//
// What was confirmed on Higgsfield's own pages, and what wasn't, is in
// specs/higgsfield-api-v1.md. In short: the API is NOT part of a
// higgsfield.ai web plan — it is a separate, prepaid USD balance, billed
// per second of video; failed and moderated requests are not billed.
//
// The flow, as documented:
//   POST https://api.higgsfield.ai/<model endpoint>     → {request_id, status_url, cancel_url}
//   GET  <status_url>  until status is terminal          → completed: video.url
//   (queued | in_progress → keep polling; failed | nsfw | canceled → stop)
//   POST <cancel_url>  only while still queued           → 202, nothing billed
// Auth on every call to api.higgsfield.ai: `Authorization: Key <id>:<secret>`.
//
// SYB's own rules around it:
//   - video only, and only through an approved proposal (../generation.ts)
//   - a hard cap on polls and on submits, and a timeout on every request
//   - the key goes to api.higgsfield.ai and nowhere else: a status or cancel
//     URL on another host is refused, and the finished file is downloaded
//     without it
//   - the charge is Higgsfield's published price for the seconds asked
//     (the status response carries no cost field); a run that never
//     finished within the cap is counted as charged, because it may be
//   - the bytes come back unlabelled: ../label stamps them before they are
//     stored anywhere (rule 33's "from the moment it exists" in SYB)
//
// No test touches the network: every call goes through `fetch`, injected.

import { randomUUID } from "node:crypto";
import type { Money } from "../../core/money";
import { money } from "../../core/money";
import type {
  GeneratedMedia,
  GenerationOutput,
  GenerationRequest,
  MediaProvider,
} from "./provider";
import { GENERATED_CLIP_SECONDS, ProviderError } from "./provider";

export const HIGGSFIELD_ORIGIN = "https://api.higgsfield.ai";
export const HIGGSFIELD_CURRENCY = "USD";

/**
 * Hard limits on one generation. 45 polls × 5 s fits one attempt inside a
 * 300 s function; a request's deadline_at (the run's own budget) stops a
 * retry from running past it.
 */
export const HIGGSFIELD_LIMITS = {
  poll_interval_ms: 5_000,
  max_polls: 45,
  /** Submits per attempt: one more, with the same Idempotency-Key, after a transport failure. */
  max_submits: 2,
  request_timeout_ms: 20_000,
  download_timeout_ms: 90_000,
  /** A 15 s 1080p clip is a few tens of MB; anything far past that is refused. */
  max_bytes: 150 * 1024 * 1024,
  /** The documented prompt limit for Kling 3.0 Pro, text to video. */
  max_prompt_chars: 2_500,
} as const;

export const HIGGSFIELD_NO_KEY =
  "AI video needs Higgsfield API access: buy API credit at higgsfield.ai (it is separate from a web plan), create a key in its console, and set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET on the server";

export const HIGGSFIELD_VIDEO_ONLY =
  "Higgsfield is set up for video here; pictures come from your own photos";

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HiggsfieldOptions {
  key: { id: string; secret: string } | null;
  /** The model endpoint, e.g. "kling-video/v3.0/pro/text-to-video". */
  model: string;
  /** Higgsfield's published price, in millionths of a dollar per second. */
  usd_micros_per_second: number;
  fetch?: HttpFetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock a request's deadline_at is read against (tests inject it). */
  now?: () => number;
  limits?: Partial<Record<keyof typeof HIGGSFIELD_LIMITS, number>>;
}

/** The statuses Higgsfield documents (RequestStatus.status). */
export type HiggsfieldStatus =
  "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";

interface StatusBody {
  status?: unknown;
  request_id?: unknown;
  status_url?: unknown;
  cancel_url?: unknown;
  error?: unknown;
  video?: { url?: unknown } | null;
}

/** Pure: the price of `seconds` of video, rounded up to the cent (rule 1: integer minor units). */
export function higgsfieldPrice(usdMicrosPerSecond: number, seconds: number): Money {
  return money(Math.ceil((usdMicrosPerSecond * seconds) / 10_000), HIGGSFIELD_CURRENCY);
}

/**
 * Pure: the request body for a model. Kling's text-to-video fields are
 * confirmed (prompt, duration, aspect_ratio, sound); another model's are
 * sent in the shape Higgsfield's overview shows (prompt, duration,
 * aspect_ratio) and are unverified — see the spec.
 */
export function higgsfieldBody(
  model: string,
  req: Pick<GenerationRequest, "prompt" | "instruction" | "aspect" | "seconds">,
  maxChars: number = HIGGSFIELD_LIMITS.max_prompt_chars,
): Record<string, unknown> {
  // The fixed instruction always goes; the prompt gives way when the two are too long together.
  const room = maxChars - req.instruction.length - 2;
  const prompt =
    req.prompt.length > room ? `${req.prompt.slice(0, Math.max(0, room - 1))}…` : req.prompt;
  const body: Record<string, unknown> = {
    prompt: `${prompt}\n\n${req.instruction}`,
    duration: req.seconds ?? GENERATED_CLIP_SECONDS,
    aspect_ratio: req.aspect === "9:16" ? "9:16" : "1:1",
  };
  // No sound: an AI voice or music could claim things no fact backs.
  if (model.startsWith("kling-video/")) body.sound = "off";
  return body;
}

/** Pure: is this URL on Higgsfield's API host? Only those see the key. */
export function onHiggsfieldHost(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.origin === HIGGSFIELD_ORIGIN && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Pure: does this look like an MP4 (an ISO-BMFF `ftyp` box first)? */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 12 &&
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  );
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const d = body.detail;
    const text =
      typeof d === "string" ? d : Array.isArray(d) ? JSON.stringify(d) : `HTTP ${res.status}`;
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return `HTTP ${res.status}`;
  }
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function higgsfieldMediaProvider(opts: HiggsfieldOptions): MediaProvider {
  const limits: Record<keyof typeof HIGGSFIELD_LIMITS, number> = {
    ...HIGGSFIELD_LIMITS,
    ...opts.limits,
  };
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? sleepFor;
  const clock = opts.now ?? Date.now;
  const key = opts.key;
  const model = opts.model;
  const auth = key ? `Key ${key.id}:${key.secret}` : "";
  const priceOf = (seconds = GENERATED_CLIP_SECONDS) =>
    higgsfieldPrice(opts.usd_micros_per_second, seconds);

  const call = (url: string, init: RequestInit, timeoutMs = limits.request_timeout_ms) =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  async function submit(req: GenerationRequest, idempotencyKey: string): Promise<StatusBody> {
    const body = JSON.stringify(higgsfieldBody(model, req, limits.max_prompt_chars));
    let lastError = "Higgsfield didn't answer";
    for (let n = 1; n <= limits.max_submits; n++) {
      let res: Response;
      try {
        res = await call(`${HIGGSFIELD_ORIGIN}/${model}`, {
          method: "POST",
          headers: {
            authorization: auth,
            "content-type": "application/json",
            accept: "application/json",
            // The same key on a resubmission: Higgsfield returns the first request, never a second charge.
            "idempotency-key": idempotencyKey,
          },
          body,
        });
      } catch {
        lastError = "Higgsfield didn't answer";
        continue;
      }
      if (res.ok) return (await res.json()) as StatusBody;
      const detail = await detailOf(res);
      if (res.status === 401) {
        throw new ProviderError(
          "Higgsfield refused the API key — check HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET",
        );
      }
      if (res.status === 403) {
        throw new ProviderError(
          "Higgsfield's API balance is too low for this — top it up in Higgsfield's API console (a web plan's credits don't count)",
        );
      }
      if (res.status === 404) {
        throw new ProviderError(`Higgsfield doesn't offer the model "${model}" to this account`);
      }
      if (res.status === 400 || res.status === 422) {
        throw new ProviderError(`Higgsfield refused the request: ${detail}`);
      }
      // 423 (model blocked for now), 429 (queue full), 5xx: worth another attempt, nothing billed.
      throw new ProviderError(`Higgsfield is busy right now (${detail})`, { retryable: true });
    }
    throw new ProviderError(lastError, { retryable: true });
  }

  async function cancel(cancelUrl: unknown): Promise<boolean> {
    if (!onHiggsfieldHost(cancelUrl)) return false;
    try {
      const res = await call(cancelUrl, { method: "POST", headers: { authorization: auth } });
      return res.status === 202 || res.ok;
    } catch {
      return false;
    }
  }

  async function download(url: unknown, cost: Money): Promise<Uint8Array> {
    const charged = { cost };
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new ProviderError("Higgsfield finished but gave no video address", charged);
    }
    let res: Response;
    try {
      // Without the key: the file sits on a delivery host, not the API.
      res = await call(url, { method: "GET" }, limits.download_timeout_ms);
    } catch {
      throw new ProviderError("the finished video couldn't be downloaded from Higgsfield", charged);
    }
    if (!res.ok) {
      throw new ProviderError(
        `the finished video couldn't be downloaded from Higgsfield (HTTP ${res.status})`,
        charged,
      );
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > limits.max_bytes) {
      throw new ProviderError("Higgsfield's video is larger than SYB accepts", charged);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > limits.max_bytes) {
      throw new ProviderError("Higgsfield's video was empty or too large", charged);
    }
    if (!looksLikeMp4(bytes)) {
      throw new ProviderError("Higgsfield returned something that isn't an MP4 video", charged);
    }
    return bytes;
  }

  return {
    id: "higgsfield",
    unavailable: key ? null : HIGGSFIELD_NO_KEY,
    supports: ["video"] as const satisfies readonly GeneratedMedia[],
    estimate(req) {
      if (req.media !== "video") throw new ProviderError(HIGGSFIELD_VIDEO_ONLY);
      return priceOf(req.seconds);
    },
    async generate(req): Promise<GenerationOutput> {
      if (req.media !== "video") throw new ProviderError(HIGGSFIELD_VIDEO_ONLY);
      if (!key) throw new ProviderError(HIGGSFIELD_NO_KEY);
      const cost = priceOf(req.seconds);
      // The run's own time limit: nothing is submitted that couldn't be waited for.
      const deadline = req.deadline_at ?? Number.POSITIVE_INFINITY;
      if (clock() + limits.poll_interval_ms > deadline) {
        throw new ProviderError(
          "there was no time left in this run to wait for Higgsfield, so nothing was submitted or billed",
        );
      }
      const submitted = await submit(req, req.idempotency_key ?? randomUUID());
      const requestId =
        typeof submitted.request_id === "string" &&
        /^[A-Za-z0-9-]{8,64}$/.test(submitted.request_id)
          ? submitted.request_id
          : null;
      if (!requestId) {
        // Accepted, maybe: count it as charged rather than pretend it cost nothing.
        throw new ProviderError("Higgsfield accepted the request but gave no request id", {
          cost,
        });
      }
      const statusUrl = onHiggsfieldHost(submitted.status_url)
        ? submitted.status_url
        : `${HIGGSFIELD_ORIGIN}/requests/${requestId}/status`;
      const cancelUrl = onHiggsfieldHost(submitted.cancel_url)
        ? submitted.cancel_url
        : `${HIGGSFIELD_ORIGIN}/requests/${requestId}/cancel`;

      let checks = 0;
      for (let poll = 1; poll <= limits.max_polls; poll++) {
        // Out of time before the cap: stop waiting, exactly as at the cap.
        if (clock() + limits.poll_interval_ms > deadline) break;
        checks = poll;
        await sleep(limits.poll_interval_ms);
        let body: StatusBody;
        try {
          const res = await call(statusUrl, {
            method: "GET",
            headers: { authorization: auth, accept: "application/json" },
          });
          if (res.status === 401 || res.status === 404) {
            throw new ProviderError(
              `Higgsfield lost track of request ${requestId} (HTTP ${res.status})`,
              { cost },
            );
          }
          if (!res.ok) continue; // 5xx: the next poll, within the cap
          body = (await res.json()) as StatusBody;
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          continue; // a dropped poll counts against the cap like any other
        }
        const status = body.status as HiggsfieldStatus | undefined;
        if (status === "completed") {
          const bytes = await download(body.video?.url, cost);
          return {
            bytes,
            content_type: "video/mp4",
            cost,
            model: `higgsfield/${model}`,
            request_id: requestId,
          };
        }
        if (status === "failed") {
          // Documented: a failed request isn't billed. Another attempt may succeed.
          const why = typeof body.error === "string" ? `: ${body.error.slice(0, 160)}` : "";
          throw new ProviderError(`Higgsfield couldn't make this clip${why}`, {
            retryable: true,
          });
        }
        if (status === "nsfw") {
          throw new ProviderError(
            "Higgsfield's moderation refused this prompt or its result — nothing was billed",
          );
        }
        if (status === "canceled") {
          throw new ProviderError("the request was canceled at Higgsfield — nothing was billed");
        }
        // queued | in_progress | anything new: poll again, within the cap.
      }
      // The cap: cancel while it's still queued (unbilled), or count it as charged.
      if (await cancel(cancelUrl)) {
        throw new ProviderError(
          `Higgsfield hadn't started request ${requestId} after ${checks} checks, so it was canceled — nothing was billed`,
        );
      }
      throw new ProviderError(
        `Higgsfield didn't finish request ${requestId} within ${checks} checks; it may still finish and be billed, so it is counted as spent`,
        { cost },
      );
    },
  };
}
