// Higgsfield's API as a MediaProvider — P6-03 (Phase 6, rules 33 and 34).
//
// What was confirmed on Higgsfield's own pages, and what wasn't, is in
// specs/higgsfield-api-v1.md. In short: the API is NOT part of a
// higgsfield.ai web plan — it is a separate, prepaid USD balance, billed
// per second of video; failed and moderated requests are not billed.
//
// The flow, as documented:
//   POST https://api.higgsfield.ai/<model endpoint>     → {request_id, status_url, cancel_url}
//   GET  <status_url>                                    → queued | in_progress | completed (video.url)
//                                                          | failed | nsfw | canceled
//   POST <cancel_url>  only while still queued           → 202, nothing billed
// Auth on every call to api.higgsfield.ai: `Authorization: Key <id>:<secret>`.
//
// The owner's decision of 2026-11-09 ("the best solution top businesses are
// currently doing"): SYB SUBMITS and returns at once, and asks after the
// request later, one status check at a time (../candidates.ts, the
// studio's poll and the collect-video cron). Nothing here sleeps or waits
// for a clip: each call below is one HTTP request with its own timeout.
// Higgsfield's webhook parameter isn't documented on the pages read
// (specs/higgsfield-api-v1.md), so polling is the source of truth.
//
// SYB's own rules around it:
//   - video only, and only through an approved proposal (../generation.ts)
//   - a hard cap on submits, and a timeout on every request
//   - the key goes to api.higgsfield.ai and nowhere else: a status or cancel
//     URL on another host is refused, and the finished file is downloaded
//     without it
//   - the charge is Higgsfield's published price for the seconds asked
//     (the status response carries no cost field); a request SYB lost
//     track of is counted as charged, because it may be
//   - the bytes come back unlabelled: ../label stamps them before they are
//     stored anywhere (rule 33's "from the moment it exists" in SYB)
//
// No test touches the network: every call goes through `fetch`, injected.

import { randomUUID } from "node:crypto";
import type { Money } from "../../core/money";
import { money } from "../../core/money";
import { vetAddresses } from "../../site/fetch";
import type {
  GeneratedMedia,
  GenerationOutput,
  GenerationRequest,
  JobCheck,
  MediaProvider,
  SubmittedJob,
} from "./provider";
import { GENERATED_CLIP_SECONDS, ProviderError } from "./provider";

export const HIGGSFIELD_ORIGIN = "https://api.higgsfield.ai";
export const HIGGSFIELD_CURRENCY = "USD";

/** Hard limits on each call. No poll interval: SYB never waits on a request. */
export const HIGGSFIELD_LIMITS = {
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
  /**
   * Checked against the finished video's delivery URL before it's fetched
   * (security review 2026-11-09) — rejects by throwing. Defaults to the
   * real DNS-resolving address check (lib/site/fetch's vetAddresses), the
   * same one site-audit and competitor reads use; tests inject a stub so
   * the suite stays network-free.
   */
  vetUrl?: (url: URL) => Promise<unknown>;
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

/** Pure: Higgsfield's request ids are uuids; anything else isn't trusted into a URL. */
export function isRequestId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
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

export function higgsfieldMediaProvider(opts: HiggsfieldOptions): MediaProvider {
  const limits: Record<keyof typeof HIGGSFIELD_LIMITS, number> = {
    ...HIGGSFIELD_LIMITS,
    ...opts.limits,
  };
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const vetUrl = opts.vetUrl ?? vetAddresses;
  const key = opts.key;
  const model = opts.model;
  const auth = key ? `Key ${key.id}:${key.secret}` : "";
  const priceOf = (seconds = GENERATED_CLIP_SECONDS) =>
    higgsfieldPrice(opts.usd_micros_per_second, seconds);
  // The clip SYB always asks for: the charge of a finished (or maybe-finished) request.
  const clipCost = priceOf();

  const call = (url: string, init: RequestInit, timeoutMs = limits.request_timeout_ms) =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  async function post(req: GenerationRequest, idempotencyKey: string): Promise<StatusBody> {
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

  async function download(url: string): Promise<Uint8Array> {
    // A finished request is billed: every refusal below still counts its price.
    const charged = { cost: clipCost };
    if (!url.startsWith("https://")) {
      throw new ProviderError("Higgsfield finished but gave no video address", charged);
    }
    // Security review 2026-11-09: unlike status_url/cancel_url (checked
    // against HIGGSFIELD_ORIGIN by onHiggsfieldHost), this delivery URL is
    // legitimately on a different, unpredictable CDN host — so it can't be
    // host-allowlisted the same way. What it CAN be is kept off a private
    // network: the same address-vetting lib/site/fetch.ts uses for
    // attacker-adjacent fetches (site audit, competitor reads), applied
    // here against a vendor response that could in principle be
    // manipulated (compromised account, MITM) into pointing this server at
    // itself or at a cloud metadata address. No API key goes out on this
    // request either way.
    try {
      await vetUrl(new URL(url));
    } catch {
      throw new ProviderError("Higgsfield's video address doesn't look safe to fetch", charged);
    }
    let res: Response;
    try {
      // Without the key: the file sits on a delivery host, not the API.
      // redirect: "error" — a redirect would point at an address never
      // vetted above; refuse rather than follow it blind.
      res = await call(url, { method: "GET", redirect: "error" }, limits.download_timeout_ms);
    } catch {
      // Kept at Higgsfield for at least seven days: another run downloads it.
      throw new ProviderError("the finished video couldn't be downloaded from Higgsfield yet", {
        ...charged,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ProviderError(
        `the finished video couldn't be downloaded from Higgsfield (HTTP ${res.status})`,
        { ...charged, retryable: res.status >= 500 || res.status === 429 },
      );
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > limits.max_bytes) {
      throw new ProviderError("Higgsfield's video is larger than ScaleX accepts", charged);
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
    jobs: {
      async submit(req): Promise<SubmittedJob> {
        if (req.media !== "video") throw new ProviderError(HIGGSFIELD_VIDEO_ONLY);
        if (!key) throw new ProviderError(HIGGSFIELD_NO_KEY);
        const submitted = await post(req, req.idempotency_key ?? randomUUID());
        if (!isRequestId(submitted.request_id)) {
          // Accepted, maybe: count it as charged rather than pretend it cost nothing.
          throw new ProviderError("Higgsfield accepted the request but gave no request id", {
            cost: priceOf(req.seconds),
          });
        }
        const id = submitted.request_id;
        return {
          request_id: id,
          status_url: onHiggsfieldHost(submitted.status_url)
            ? submitted.status_url
            : `${HIGGSFIELD_ORIGIN}/requests/${id}/status`,
          cancel_url: onHiggsfieldHost(submitted.cancel_url)
            ? submitted.cancel_url
            : `${HIGGSFIELD_ORIGIN}/requests/${id}/cancel`,
        };
      },

      async check(job): Promise<JobCheck> {
        if (!key) return { state: "pending", status: "no_key" };
        // The key never leaves for another host: a stored address is checked again on use.
        const statusUrl = onHiggsfieldHost(job.status_url)
          ? job.status_url
          : isRequestId(job.request_id)
            ? `${HIGGSFIELD_ORIGIN}/requests/${job.request_id}/status`
            : null;
        if (!statusUrl) {
          return {
            state: "failed",
            message: "ScaleX has no usable address for this Higgsfield request; counted as spent",
            retryable: false,
            charged: clipCost,
          };
        }
        let body: StatusBody;
        try {
          const res = await call(statusUrl, {
            method: "GET",
            headers: { authorization: auth, accept: "application/json" },
          });
          if (res.status === 401 || res.status === 404) {
            // It may have run: counted as spent.
            return {
              state: "failed",
              message: `Higgsfield lost track of request ${job.request_id} (HTTP ${res.status})`,
              retryable: false,
              charged: clipCost,
            };
          }
          if (!res.ok) return { state: "pending", status: `http_${res.status}` };
          body = (await res.json()) as StatusBody;
        } catch {
          return { state: "pending", status: "no_answer" }; // asked again on the next run
        }
        const status = body.status as HiggsfieldStatus | undefined;
        if (status === "completed") {
          const url = body.video?.url;
          if (typeof url !== "string" || url === "") {
            return {
              state: "failed",
              message: "Higgsfield finished but gave no video address",
              retryable: false,
              charged: clipCost,
            };
          }
          return { state: "completed", result_url: url };
        }
        if (status === "failed") {
          // Documented: a failed request isn't billed. Another attempt may succeed.
          const why = typeof body.error === "string" ? `: ${body.error.slice(0, 160)}` : "";
          return {
            state: "failed",
            message: `Higgsfield couldn't make this clip${why}`,
            retryable: true,
            charged: null,
          };
        }
        if (status === "nsfw") {
          return {
            state: "failed",
            message:
              "Higgsfield's moderation refused this prompt or its result — nothing was billed",
            retryable: false,
            charged: null,
          };
        }
        if (status === "canceled") {
          return {
            state: "failed",
            message: "the request was canceled at Higgsfield — nothing was billed",
            retryable: false,
            charged: null,
          };
        }
        // queued | in_progress | anything new: asked again on the next run.
        return { state: "pending", status: typeof status === "string" ? status : "unknown" };
      },

      async fetchResult(job, resultUrl): Promise<GenerationOutput> {
        const bytes = await download(resultUrl);
        return {
          bytes,
          content_type: "video/mp4",
          cost: clipCost,
          model: `higgsfield/${model}`,
          request_id: job.request_id,
        };
      },

      async cancel(job): Promise<boolean> {
        if (!key || !onHiggsfieldHost(job.cancel_url)) return false;
        try {
          const res = await call(job.cancel_url, {
            method: "POST",
            headers: { authorization: auth },
          });
          return res.status === 202 || res.ok;
        } catch {
          return false;
        }
      },
    },
  };
}
