// P6-03 — Higgsfield's API as a MediaProvider, against a fake HTTP layer
// only: no test here (or anywhere) calls Higgsfield. What must hold: the
// documented flow — submit, then one status check at a time, never a
// wait (the owner's decision of 2026-11-09) — with the key on Higgsfield's
// host and nowhere else; the price in integer US cents; video only; every
// failure named, the billable ones counted as charged and the unbilled
// ones not; a hard cap on submits; and the switch and its env keys.

import "dotenv/config";
import { afterEach, describe, expect, it } from "vitest";
import { HIGGSFIELD_DEFAULTS, higgsfieldEnv, mediaProviderSetting } from "../../env";
import { GENERATION_OFF, generationSetup } from "../generation";
import {
  HIGGSFIELD_LIMITS,
  HIGGSFIELD_NO_KEY,
  HIGGSFIELD_ORIGIN,
  HIGGSFIELD_VIDEO_ONLY,
  higgsfieldBody,
  higgsfieldMediaProvider,
  higgsfieldPrice,
  looksLikeMp4,
  onHiggsfieldHost,
} from "./higgsfield";
import type { HttpFetch } from "./higgsfield";
import { FIXED_INSTRUCTION, ProviderError } from "./provider";
import type { GenerationRequest, SubmittedJob } from "./provider";

const MODEL = HIGGSFIELD_DEFAULTS.model;
const KEY = { id: "kid-123", secret: "ksecret-456" };
const ID = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";
const MP4 = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
]);

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A scripted Higgsfield: submit answers, then the statuses in order, then the file. */
function fakeApi(script: {
  submit?: (n: number) => Response | Error;
  statuses?: (string | Response)[];
  video?: () => Response;
  cancel?: number;
  statusUrl?: string;
}): { fetch: HttpFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let submits = 0;
  let polls = 0;
  const fetch: HttpFetch = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    sent.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url === `${HIGGSFIELD_ORIGIN}/${MODEL}`) {
      submits += 1;
      const r = script.submit?.(submits) ?? json(200, {});
      if (r instanceof Error) throw r;
      if (r.status === 200 && (await r.clone().text()) === "{}") {
        return json(200, {
          status: "queued",
          request_id: ID,
          status_url: script.statusUrl ?? `${HIGGSFIELD_ORIGIN}/requests/${ID}/status`,
          cancel_url: `${HIGGSFIELD_ORIGIN}/requests/${ID}/cancel`,
        });
      }
      return r;
    }
    if (url.endsWith("/status")) {
      const s = script.statuses?.[polls] ?? script.statuses?.at(-1) ?? "completed";
      polls += 1;
      if (s instanceof Response) return s;
      return json(200, {
        status: s,
        request_id: ID,
        ...(s === "completed" ? { video: { url: `https://cdn.higgsfield.test/${ID}.mp4` } } : {}),
        ...(s === "failed" ? { error: "the model fell over" } : {}),
      });
    }
    if (url.endsWith("/cancel")) return new Response(null, { status: script.cancel ?? 400 });
    if (url.startsWith("https://cdn.higgsfield.test/")) {
      return script.video?.() ?? new Response(MP4, { status: 200 });
    }
    throw new Error(`unexpected call to ${url}`);
  };
  return { fetch, sent };
}

const provider = (fetch: HttpFetch, limits = {}) =>
  higgsfieldMediaProvider({
    key: KEY,
    model: MODEL,
    usd_micros_per_second: HIGGSFIELD_DEFAULTS.usd_micros_per_second,
    fetch,
    limits,
  });

const request: GenerationRequest = {
  media: "video",
  prompt: "Photorealistic footage of fresh sourdough on a counter.",
  instruction: FIXED_INSTRUCTION,
  aspect: "9:16",
  seconds: 5,
  account_id: "acct",
  idempotency_key: "syb-claim-1-1",
};

const rejection = async (p: Promise<unknown>): Promise<ProviderError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProviderError);
  return e as ProviderError;
};

describe("P6-03 — Higgsfield, pure", () => {
  it("prices in integer US cents, rounded up (rule 1)", () => {
    expect(higgsfieldPrice(112_000, 5)).toEqual({ amount_minor: 56, currency: "USD" });
    expect(higgsfieldPrice(42_000, 5)).toEqual({ amount_minor: 21, currency: "USD" });
    expect(higgsfieldPrice(73_800, 5)).toEqual({ amount_minor: 37, currency: "USD" });
  });

  it("sends Kling's documented fields, the fixed instruction always, no sound", () => {
    const body = higgsfieldBody(MODEL, request);
    expect(body).toEqual({
      prompt: `${request.prompt}\n\n${FIXED_INSTRUCTION}`,
      duration: 5,
      aspect_ratio: "9:16",
      sound: "off",
    });
    // Too long together: the prompt gives way, the instruction never does.
    const long = higgsfieldBody(MODEL, { ...request, prompt: "x".repeat(5_000) });
    expect((long.prompt as string).length).toBeLessThanOrEqual(2_500);
    expect(long.prompt as string).toMatch(new RegExp(`${FIXED_INSTRUCTION.slice(-40)}$`));
    expect(higgsfieldBody("bytedance/seedance-2.0/text-to-video", request)).not.toHaveProperty(
      "sound",
    );
  });

  it("knows Higgsfield's host from any other, and an MP4 from anything else", () => {
    expect(onHiggsfieldHost(`${HIGGSFIELD_ORIGIN}/requests/x/status`)).toBe(true);
    expect(onHiggsfieldHost("https://api.higgsfield.ai.evil.test/requests/x/status")).toBe(false);
    expect(onHiggsfieldHost("https://user:pw@api.higgsfield.ai/requests/x")).toBe(false);
    expect(onHiggsfieldHost("http://api.higgsfield.ai/requests/x")).toBe(false);
    expect(onHiggsfieldHost(42)).toBe(false);
    expect(looksLikeMp4(MP4)).toBe(true);
    expect(looksLikeMp4(new TextEncoder().encode("<html>not a video</html>"))).toBe(false);
  });
});

describe("P6-03 — Higgsfield, submit now and ask later (fake HTTP only)", () => {
  const jobsOf = (fetch: HttpFetch, limits = {}) => provider(fetch, limits).jobs!;
  const JOB: SubmittedJob = {
    request_id: ID,
    status_url: `${HIGGSFIELD_ORIGIN}/requests/${ID}/status`,
    cancel_url: `${HIGGSFIELD_ORIGIN}/requests/${ID}/cancel`,
  };

  it("has no in-request wait: it submits, checks and downloads, one call each", () => {
    const p = provider(fakeApi({}).fetch);
    expect(p.generate).toBeUndefined();
    expect(p.jobs).toBeDefined();
    expect(Object.keys(HIGGSFIELD_LIMITS)).not.toContain("max_polls");
    expect(Object.keys(HIGGSFIELD_LIMITS)).not.toContain("poll_interval_ms");
  });

  it("submit returns at once with the key on Higgsfield's host — no status is read", async () => {
    const api = fakeApi({ statuses: ["queued"] });
    const job = await jobsOf(api.fetch).submit(request);
    expect(job).toEqual(JOB);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({
      url: `${HIGGSFIELD_ORIGIN}/${MODEL}`,
      method: "POST",
      headers: {
        authorization: `Key ${KEY.id}:${KEY.secret}`,
        "content-type": "application/json",
        "idempotency-key": "syb-claim-1-1",
      },
      body: { duration: 5, aspect_ratio: "9:16", sound: "off" },
    });
  });

  it("one check is one GET with the key; the finished file is downloaded without it", async () => {
    const api = fakeApi({ statuses: ["in_progress", "completed"] });
    const jobs = jobsOf(api.fetch);
    expect(await jobs.check(JOB)).toEqual({ state: "pending", status: "in_progress" });
    const done = await jobs.check(JOB);
    expect(done).toEqual({
      state: "completed",
      result_url: `https://cdn.higgsfield.test/${ID}.mp4`,
    });
    const out = await jobs.fetchResult(JOB, (done as { result_url: string }).result_url);
    expect(out).toMatchObject({
      content_type: "video/mp4",
      cost: { amount_minor: 56, currency: "USD" },
      model: `higgsfield/${MODEL}`,
      request_id: ID,
    });
    expect(out.bytes).toEqual(MP4);
    const polls = api.sent.filter((s) => s.url.endsWith("/status"));
    expect(polls).toHaveLength(2);
    for (const p of polls) expect(p.headers.authorization).toBe(`Key ${KEY.id}:${KEY.secret}`);
    const download = api.sent.find((s) => s.url.startsWith("https://cdn.higgsfield.test/"));
    expect(download?.headers.authorization).toBeUndefined();
  });

  it("never sends the key to a status or cancel URL on another host", async () => {
    const api = fakeApi({ statusUrl: "https://collector.evil.test/requests/x/status" });
    const jobs = jobsOf(api.fetch);
    const job = await jobs.submit(request);
    expect(job.status_url).toBe(`${HIGGSFIELD_ORIGIN}/requests/${ID}/status`);
    // A stored address is checked again on use.
    await jobs.check({ ...job, status_url: "https://collector.evil.test/requests/x/status" });
    expect(await jobs.cancel({ ...job, cancel_url: "https://collector.evil.test/x/cancel" })).toBe(
      false,
    );
    const hosts = api.sent.filter((s) => s.headers.authorization).map((s) => new URL(s.url).origin);
    expect(new Set(hosts)).toEqual(new Set([HIGGSFIELD_ORIGIN]));
    expect(api.sent.some((s) => s.url.includes("evil.test"))).toBe(false);
  });

  it("video only, and without a key it says what's needed and calls nothing", async () => {
    const api = fakeApi({});
    const p = provider(api.fetch);
    expect(p.supports).toEqual(["video"]);
    expect(() => p.estimate({ media: "image" })).toThrow(HIGGSFIELD_VIDEO_ONLY);
    expect(p.estimate({ media: "video", seconds: 5 })).toEqual({
      amount_minor: 56,
      currency: "USD",
    });
    const none = higgsfieldMediaProvider({
      key: null,
      model: MODEL,
      usd_micros_per_second: 112_000,
      fetch: api.fetch,
    });
    expect(none.unavailable).toBe(HIGGSFIELD_NO_KEY);
    expect(none.unavailable).toMatch(/HIGGSFIELD_API_KEY/);
    expect(none.unavailable).toMatch(/separate from a web plan/);
    await rejection(none.jobs!.submit(request));
    expect(await none.jobs!.check(JOB)).toMatchObject({ state: "pending" });
    expect(await none.jobs!.cancel(JOB)).toBe(false);
    expect(api.sent).toHaveLength(0);
  });

  it("names each refusal: a bad key, an empty balance, a bad request — none retried, none charged", async () => {
    for (const [status, words] of [
      [401, /refused the API key/],
      [403, /balance is too low/],
      [404, /doesn't offer the model/],
      [422, /refused the request: prompt too long/],
    ] as const) {
      const api = fakeApi({ submit: () => json(status, { detail: "prompt too long" }) });
      const e = await rejection(jobsOf(api.fetch).submit(request));
      expect(e.message).toMatch(words);
      expect(e.retryable).toBe(false);
      expect(e.cost).toBeNull();
      expect(api.sent).toHaveLength(1);
    }
  });

  it("a busy Higgsfield is worth another attempt, unbilled", async () => {
    for (const status of [423, 429, 500, 503]) {
      const api = fakeApi({ submit: () => json(status, { detail: "account_queue_full" }) });
      const e = await rejection(jobsOf(api.fetch).submit(request));
      expect(e).toMatchObject({ retryable: true, cost: null });
    }
  });

  it("resubmits once after a dropped connection, with the same Idempotency-Key", async () => {
    const api = fakeApi({
      submit: (n) => (n === 1 ? new Error("socket hang up") : json(200, {})),
    });
    await jobsOf(api.fetch).submit(request);
    const submits = api.sent.filter((s) => s.method === "POST");
    expect(submits).toHaveLength(2);
    expect(submits[0]!.headers["idempotency-key"]).toBe(submits[1]!.headers["idempotency-key"]);

    // The cap: never a third.
    const down = fakeApi({ submit: () => new Error("socket hang up") });
    const e = await rejection(jobsOf(down.fetch).submit(request));
    expect(e.retryable).toBe(true);
    expect(down.sent).toHaveLength(2);
  });

  it("an accepted request without an id is counted as charged", async () => {
    const api = fakeApi({ submit: () => json(200, { status: "queued" }) });
    const e = await rejection(jobsOf(api.fetch).submit(request));
    expect(e.cost).toEqual({ amount_minor: 56, currency: "USD" });
  });

  it("failed and moderated runs aren't billed; failed may be retried, moderated may not", async () => {
    const failed = await jobsOf(fakeApi({ statuses: ["failed"] }).fetch).check(JOB);
    expect(failed).toMatchObject({ state: "failed", retryable: true, charged: null });
    expect((failed as { message: string }).message).toMatch(/the model fell over/);
    const nsfw = await jobsOf(fakeApi({ statuses: ["nsfw"] }).fetch).check(JOB);
    expect(nsfw).toMatchObject({ state: "failed", retryable: false, charged: null });
    expect((nsfw as { message: string }).message).toMatch(/moderation/);
    const canceled = await jobsOf(fakeApi({ statuses: ["canceled"] }).fetch).check(JOB);
    expect(canceled).toMatchObject({ state: "failed", retryable: false, charged: null });
  });

  it("a check that drops is asked again later; a lost request is counted as spent", async () => {
    const flaky = jobsOf(fakeApi({ statuses: [json(502, { detail: "bad gateway" })] }).fetch);
    expect(await flaky.check(JOB)).toEqual({ state: "pending", status: "http_502" });
    const down = jobsOf(async () => {
      throw new Error("socket hang up");
    });
    expect(await down.check(JOB)).toEqual({ state: "pending", status: "no_answer" });
    const lost = await jobsOf(
      fakeApi({ statuses: [json(404, { detail: "not found" })] }).fetch,
    ).check(JOB);
    expect(lost).toMatchObject({
      state: "failed",
      retryable: false,
      charged: { amount_minor: 56, currency: "USD" },
    });
    expect((lost as { message: string }).message).toMatch(/lost track/);
  });

  it("cancel is accepted only while queued (202): canceled is free", async () => {
    expect(await jobsOf(fakeApi({ cancel: 202 }).fetch).cancel(JOB)).toBe(true);
    expect(await jobsOf(fakeApi({ cancel: 400 }).fetch).cancel(JOB)).toBe(false);
  });

  it("a finished file that isn't an MP4 is refused and charged; a dropped download is tried again", async () => {
    const url = `https://cdn.higgsfield.test/${ID}.mp4`;
    const html = fakeApi({ video: () => new Response("<html>oops</html>", { status: 200 }) });
    const e = await rejection(jobsOf(html.fetch).fetchResult(JOB, url));
    expect(e.message).toMatch(/isn't an MP4/);
    expect(e).toMatchObject({ retryable: false, cost: { amount_minor: 56, currency: "USD" } });
    const busy = fakeApi({ video: () => new Response("", { status: 503 }) });
    const later = await rejection(jobsOf(busy.fetch).fetchResult(JOB, url));
    expect(later.retryable).toBe(true);
  });
});

describe("P6-03 — the switch and its keys", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      "MEDIA_PROVIDER",
      "HIGGSFIELD_API_KEY",
      "HIGGSFIELD_API_SECRET",
      "HIGGSFIELD_MONTHLY_CAP_MINOR",
      "HIGGSFIELD_MODEL",
      "HIGGSFIELD_USD_MICROS_PER_SECOND",
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("MEDIA_PROVIDER=higgsfield selects it, in production too", () => {
    process.env.MEDIA_PROVIDER = "Higgsfield";
    expect(mediaProviderSetting()).toBe("higgsfield");
  });

  it("reads the key as id + secret, or as one id:secret; anything less is no key", () => {
    delete process.env.HIGGSFIELD_API_SECRET;
    process.env.HIGGSFIELD_API_KEY = "";
    expect(higgsfieldEnv().key).toBeNull();
    process.env.HIGGSFIELD_API_KEY = "only-an-id";
    expect(higgsfieldEnv().key).toBeNull();
    process.env.HIGGSFIELD_API_KEY = "kid:ksecret";
    expect(higgsfieldEnv().key).toEqual({ id: "kid", secret: "ksecret" });
    process.env.HIGGSFIELD_API_KEY = "kid";
    process.env.HIGGSFIELD_API_SECRET = "ksecret";
    expect(higgsfieldEnv().key).toEqual({ id: "kid", secret: "ksecret" });
  });

  it("defaults the cap to $60, the model to Kling 3.0 Pro, and refuses odd values", () => {
    delete process.env.HIGGSFIELD_MONTHLY_CAP_MINOR;
    delete process.env.HIGGSFIELD_MODEL;
    expect(higgsfieldEnv()).toMatchObject({
      monthly_cap_minor: 6000,
      model: "kling-video/v3.0/pro/text-to-video",
      usd_micros_per_second: 112_000,
    });
    process.env.HIGGSFIELD_MONTHLY_CAP_MINOR = "2500";
    expect(higgsfieldEnv().monthly_cap_minor).toBe(2500);
    for (const bad of ["-5", "60.5", "lots", "0"]) {
      process.env.HIGGSFIELD_MONTHLY_CAP_MINOR = bad;
      expect(higgsfieldEnv().monthly_cap_minor).toBe(6000);
    }
    for (const bad of ["../../admin", "https://evil.test/x", "kling video/pro"]) {
      process.env.HIGGSFIELD_MODEL = bad;
      expect(higgsfieldEnv().model).toBe(HIGGSFIELD_DEFAULTS.model);
    }
    process.env.HIGGSFIELD_MODEL = "bytedance/seedance-2.0/text-to-video";
    expect(higgsfieldEnv().model).toBe("bytedance/seedance-2.0/text-to-video");
  });

  it("with no key, the setup says what's needed; with one, three candidates in USD", () => {
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    delete process.env.HIGGSFIELD_MONTHLY_CAP_MINOR;
    const off = generationSetup("higgsfield");
    expect(off).toMatchObject({
      provider: null,
      reason: HIGGSFIELD_NO_KEY,
      missing: "higgsfield_key",
      caps: { currency: "USD", month_cap_minor: 6000 },
    });
    process.env.HIGGSFIELD_API_KEY = "kid:ksecret";
    const on = generationSetup("higgsfield");
    expect(on.provider?.id).toBe("higgsfield");
    expect(on).toMatchObject({ reason: null, candidates: 3, caps: { currency: "USD" } });
    expect(generationSetup("off").reason).toBe(GENERATION_OFF);
  });
});
