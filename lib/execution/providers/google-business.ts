// The Google Business Profile executor — I-45a lifted by the owner on
// 2026-11-16 ("make all these automatic all the owner should do is just
// approve", then "Google review replies + hours").
//
// THE ONLY CALLER of lib/google-business's three writes (client.test.ts
// holds that). Reached only through the engine, so each write inherits a
// recorded human approval of the exact change (rule 12), the emergency stop
// (checked again right before the write), one execution row per approval,
// the journal, the undo captured before attempt one (rule 16), and the
// real-write gate: `external: true`, so with SESSION_D_REAL_WRITES anything
// but "on" the engine refuses before anything is sent and the proposal stays
// approved. The trust ladder caps this provider at station 3 for good
// (lib/ladder/promotion MAX_STATION): there is no acting without the yes.
//
// TWO OPS, each reversible (lib/execution/scopes, google_business_reviews):
//   reply_to_review    PUT the approved words under one review.
//                      undo: the reply that was there before, or none (DELETE)
//   set_regular_hours  move ONE opening or closing time on one weekday
//                      (lib/google-business/hours moveEdge), PATCH with
//                      updateMask=regularHours, Google's dry run first.
//                      undo: move it back, while it is still where SYB put it
//
// Every write re-reads the live value first and refuses when Google's
// listing no longer says what the approval assumed: a reply someone else
// posted since is never overwritten, and an hour the owner moved since is
// never moved again. An earlier attempt that landed (its answer lost) is
// recognised and not repeated. A connection consented under the read-only
// lines can't write (lib/google-business/consent, googleWriteConsentCurrent).

import { createHash } from "node:crypto";
import type { FetchLike } from "../../google-business/client";
import {
  GbpRequestError,
  REVIEW_NAME_RE,
  deleteReviewReply,
  patchRegularHours,
  putReviewReply,
  readRegularHours,
  readReviewReply,
} from "../../google-business/client";
import type { GbpPeriod, HoursChange } from "../../google-business/hours";
import { changeProblem, clockWords, moveEdge, readPeriods } from "../../google-business/hours";
import type { GoogleBusinessBackend, GoogleWriteCredential } from "../../google-business/writes";
import type { Weekday } from "../../hours/schedule";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import type { ExecutionContext, ExecutionProvider } from "./fixture";

export const GBP_REPLY_OP = "reply_to_review";
export const GBP_HOURS_OP = "set_regular_hours";

const OPS = new Set<string>(
  EXECUTION_SCOPE_REGISTRY.google_business_reviews.operations.map((o) => o.op),
);

/** Google's own limit on a reply is not stated in its reference; ScaleX keeps well under any. */
export const GBP_REPLY_MAX = 4000;

export const STOPPED_BEFORE_GBP_CHANGE =
  "The emergency stop came on before the change was sent to Google. Nothing was changed.";

export class GoogleBusinessChangeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "GoogleBusinessChangeError";
    this.retryable = retryable;
  }
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface GoogleBusinessExecutionOptions {
  fetch?: FetchLike;
  backend?: () => Promise<GoogleBusinessBackend>;
}

/* ── params, read from the approved plan ── */

interface ReplyParams {
  review_name: string;
  comment: string;
  /** sha256 of the reply on Google when the owner approved, or null for none. */
  replaces_sha256: string | null;
}

function replyParams(params: Record<string, unknown>): ReplyParams {
  const name = params["review_name"];
  const comment = params["comment"];
  const sha = params["comment_sha256"];
  const replaces = params["replaces_sha256"];
  if (typeof name !== "string" || !REVIEW_NAME_RE.test(name)) {
    throw new GoogleBusinessChangeError("the reply names no Google review: nothing was sent");
  }
  if (typeof comment !== "string" || comment.trim() === "" || comment.length > GBP_REPLY_MAX) {
    throw new GoogleBusinessChangeError("the reply has no words ScaleX may post: nothing was sent");
  }
  if (sha !== sha256(comment)) {
    throw new GoogleBusinessChangeError(
      "the reply isn't the one you approved, word for word: nothing was sent",
    );
  }
  if (replaces !== null && (typeof replaces !== "string" || !/^[0-9a-f]{64}$/.test(replaces))) {
    throw new GoogleBusinessChangeError("the reply's approval is unreadable: nothing was sent");
  }
  return { review_name: name, comment, replaces_sha256: replaces };
}

interface HoursParams extends HoursChange {
  location: string;
}

function hoursParams(params: Record<string, unknown>): HoursParams {
  const c = {
    location: params["location"],
    weekday: params["weekday"],
    edge: params["edge"],
    from: params["from"],
    to: params["to"],
  } as Record<string, unknown>;
  if (typeof c.location !== "string" || c.location === "") {
    throw new GoogleBusinessChangeError(
      "the hours change names no Google listing: nothing was sent",
    );
  }
  const change: HoursChange = {
    weekday: c.weekday as Weekday,
    edge: c.edge as HoursChange["edge"],
    from: c.from as number,
    to: c.to as number,
  };
  const problem = changeProblem(change);
  if (problem !== null) throw new GoogleBusinessChangeError(`${problem}: nothing was sent`);
  return { location: c.location, ...change };
}

const DAY_WORD: Readonly<Record<Weekday, string>> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

function hoursWords(c: HoursChange): string {
  return `${c.edge === "open" ? "opening" : "closing"} time on ${DAY_WORD[c.weekday]} from ${clockWords(c.from)} to ${clockWords(c.to)}`;
}

function asChangeError(error: unknown): Error {
  if (error instanceof GoogleBusinessChangeError) return error;
  if (error instanceof GbpRequestError) {
    const retry = error.kind === "quota" || error.kind === "unavailable";
    return new GoogleBusinessChangeError(
      `Google refused the change: ${error.message}${retry ? "" : " Nothing was changed."}`,
      retry,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function logChange(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "gbp_change", ...event }));
}

export function createGoogleBusinessExecution(
  options: GoogleBusinessExecutionOptions = {},
): ExecutionProvider {
  const fetchImpl: FetchLike | undefined = options.fetch;
  const loadBackend = async (): Promise<GoogleBusinessBackend> => {
    if (options.backend) return options.backend();
    const { dbGoogleBusinessBackend } = await import("../../google-business/writes");
    return dbGoogleBusinessBackend();
  };

  interface Run {
    b: GoogleBusinessBackend;
    cred: GoogleWriteCredential;
  }

  async function open(ctx: ExecutionContext): Promise<Run> {
    const b = await loadBackend();
    const cred = await b.credential(ctx.account_id, ctx.profile_id);
    if ("refused" in cred) throw new GoogleBusinessChangeError(cred.refused);
    return { b, cred };
  }

  function sameLocation(run: Run, review_name: string): void {
    if (!review_name.startsWith(`${run.cred.account}/${run.cred.location}/reviews/`)) {
      throw new GoogleBusinessChangeError(
        "That review isn't on the Google listing ScaleX is connected to now. Nothing was sent.",
      );
    }
  }

  async function liveReply(run: Run, name: string): Promise<string | null> {
    try {
      return await readReviewReply(run.cred.access_token, name, fetchImpl);
    } catch (error) {
      throw asChangeError(error);
    }
  }

  async function livePeriods(run: Run, location: string): Promise<GbpPeriod[]> {
    if (location !== run.cred.location) {
      throw new GoogleBusinessChangeError(
        "The Google connection points at a different listing than the one you approved this for. Nothing was changed.",
      );
    }
    let raw: unknown[];
    try {
      raw = await readRegularHours(run.cred.access_token, location, fetchImpl);
    } catch (error) {
      throw asChangeError(error);
    }
    const periods = readPeriods(raw);
    if (periods === null) {
      throw new GoogleBusinessChangeError(
        "Google's hours for this listing couldn't be read, so ScaleX didn't change them.",
      );
    }
    return periods;
  }

  /** Google's dry run, the stop, then the change — the order every hours write takes. */
  async function writeHours(
    run: Run,
    location: string,
    periods: GbpPeriod[],
    halted: ExecutionContext["halted"],
  ): Promise<void> {
    try {
      await patchRegularHours(
        run.cred.access_token,
        location,
        periods,
        { validateOnly: true },
        fetchImpl,
      );
    } catch (error) {
      const e = asChangeError(error);
      throw new GoogleBusinessChangeError(
        `Google's dry run refused the change, so it was never sent for real: ${e.message}`,
        e instanceof GoogleBusinessChangeError ? e.retryable : false,
      );
    }
    if (halted && (await halted())) throw new GoogleBusinessChangeError(STOPPED_BEFORE_GBP_CHANGE);
    try {
      await patchRegularHours(
        run.cred.access_token,
        location,
        periods,
        { validateOnly: false },
        fetchImpl,
      );
    } catch (error) {
      throw asChangeError(error);
    }
  }

  /** Reads only: does Google's listing still say what the approval assumed? */
  async function check(op: string, params: Record<string, unknown>, ctx: ExecutionContext) {
    const run = await open(ctx);
    if (op === GBP_REPLY_OP) {
      const p = replyParams(params);
      sameLocation(run, p.review_name);
      const live = await liveReply(run, p.review_name);
      const liveSha = live === null ? null : sha256(live);
      if (liveSha !== p.replaces_sha256 && liveSha !== sha256(p.comment)) {
        throw new GoogleBusinessChangeError(
          "A different reply has been posted under this review on Google since you approved yours. ScaleX won't overwrite it; nothing was sent.",
        );
      }
      return { run, live };
    }
    const p = hoursParams(params);
    const periods = await livePeriods(run, p.location);
    const moved = moveEdge(periods, p);
    if (moved.kind === "refused") throw new GoogleBusinessChangeError(moved.reason);
    return { run, periods };
  }

  return {
    id: "google_business_reviews",
    external: true,

    async preflight(op, params, ctx) {
      if (!OPS.has(op)) {
        return { code: "refused", message: `"${op}" is not a change ScaleX makes on Google` };
      }
      try {
        await check(op, params, ctx);
        logChange({ account_id: ctx.account_id, op, phase: "preflight", outcome: "ok" });
        return null;
      } catch (error) {
        logChange({ account_id: ctx.account_id, op, phase: "preflight", outcome: "refused" });
        return { code: "refused", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async captureUndo(op, params, ctx) {
      if (!OPS.has(op)) return null;
      if (op === GBP_REPLY_OP) {
        const p = replyParams(params);
        const { live } = (await check(op, params, ctx)) as { live: string | null };
        return { review_name: p.review_name, previous: live };
      }
      const p = hoursParams(params);
      const { periods } = (await check(op, params, ctx)) as { periods: GbpPeriod[] };
      return {
        location: p.location,
        weekday: p.weekday,
        edge: p.edge,
        from: p.from,
        to: p.to,
        previous_periods: periods,
      };
    },

    async execute(op, params, ctx) {
      if (!OPS.has(op))
        throw new GoogleBusinessChangeError(`"${op}" is not a change ScaleX makes on Google`);
      const run = await open(ctx);
      if (op === GBP_REPLY_OP) {
        const p = replyParams(params);
        sameLocation(run, p.review_name);
        const live = await liveReply(run, p.review_name);
        const already = live !== null && sha256(live) === sha256(p.comment);
        if (!already) {
          const liveSha = live === null ? null : sha256(live);
          if (liveSha !== p.replaces_sha256) {
            throw new GoogleBusinessChangeError(
              "A different reply has been posted under this review on Google since you approved yours. ScaleX won't overwrite it; nothing was sent.",
            );
          }
          if (ctx.halted && (await ctx.halted())) {
            throw new GoogleBusinessChangeError(STOPPED_BEFORE_GBP_CHANGE);
          }
          try {
            await putReviewReply(run.cred.access_token, p.review_name, p.comment, fetchImpl);
          } catch (error) {
            throw asChangeError(error);
          }
        }
        await run.b.changed(ctx.profile_id, `Posted your approved reply to a review on Google.`, {
          op,
          review_name: p.review_name,
        });
        logChange({
          account_id: ctx.account_id,
          op,
          phase: "execute",
          outcome: already ? "already" : "posted",
        });
        return { review_name: p.review_name, comment_sha256: sha256(p.comment) };
      }
      const p = hoursParams(params);
      const periods = await livePeriods(run, p.location);
      const moved = moveEdge(periods, p);
      if (moved.kind === "refused") throw new GoogleBusinessChangeError(moved.reason);
      if (moved.kind === "moved") await writeHours(run, p.location, moved.periods, ctx.halted);
      await run.b.changed(ctx.profile_id, `Changed your Google listing's ${hoursWords(p)}.`, {
        op,
        weekday: p.weekday,
        edge: p.edge,
        from: p.from,
        to: p.to,
      });
      logChange({ account_id: ctx.account_id, op, phase: "execute", outcome: moved.kind });
      return { location: p.location, weekday: p.weekday, edge: p.edge, from: p.from, to: p.to };
    },

    async undo(op, undoPayload, ctx) {
      const run = await open(ctx);
      const u = (undoPayload ?? {}) as Record<string, unknown>;
      if (op === GBP_REPLY_OP) {
        const name = u["review_name"];
        const previous = u["previous"];
        if (typeof name !== "string" || !REVIEW_NAME_RE.test(name)) {
          throw new GoogleBusinessChangeError(
            "the stored undo names no review: nothing was changed",
          );
        }
        if (previous !== null && typeof previous !== "string") {
          throw new GoogleBusinessChangeError("the stored undo is unreadable: nothing was changed");
        }
        sameLocation(run, name);
        const done = (ctx.result ?? {}) as { comment_sha256?: unknown };
        const live = await liveReply(run, name);
        const liveSha = live === null ? null : sha256(live);
        if (liveSha !== (previous === null ? null : sha256(previous))) {
          if (liveSha === null || liveSha !== done.comment_sha256) {
            throw new GoogleBusinessChangeError(
              "I didn't undo this: the reply on Google isn't the one ScaleX posted any more: it has been changed since, and I won't override that. Nothing was changed.",
            );
          }
          try {
            if (previous === null) await deleteReviewReply(run.cred.access_token, name, fetchImpl);
            else await putReviewReply(run.cred.access_token, name, previous, fetchImpl);
          } catch (error) {
            throw asChangeError(error);
          }
        }
        await run.b.changed(
          ctx.profile_id,
          previous === null
            ? "Undid: removed the reply ScaleX posted on Google."
            : "Undid: put back the reply that was on Google before.",
          { op, undo: true, review_name: name },
        );
        logChange({ account_id: ctx.account_id, op, phase: "undo", outcome: "restored" });
        return { review_name: name, restored: previous === null ? "none" : "previous" };
      }
      if (op === GBP_HOURS_OP) {
        const p = hoursParams(u);
        // Back the other way: from where SYB put it, to where it was.
        const back: HoursChange = { weekday: p.weekday, edge: p.edge, from: p.to, to: p.from };
        const periods = await livePeriods(run, p.location);
        const moved = moveEdge(periods, back);
        if (moved.kind === "refused") {
          throw new GoogleBusinessChangeError(
            `I didn't undo this: your Google listing's ${p.edge === "open" ? "opening" : "closing"} time on ${DAY_WORD[p.weekday]} isn't ${clockWords(p.to)} any more: you've changed it since, and I won't override that. Nothing was changed.`,
          );
        }
        if (moved.kind === "moved") await writeHours(run, p.location, moved.periods, undefined);
        await run.b.changed(ctx.profile_id, `Undid: your Google listing's ${hoursWords(back)}.`, {
          op,
          undo: true,
          weekday: p.weekday,
        });
        logChange({ account_id: ctx.account_id, op, phase: "undo", outcome: "restored" });
        return { location: p.location, weekday: p.weekday, edge: p.edge, restored: p.from };
      }
      throw new GoogleBusinessChangeError(`"${op}" can't be undone`);
    },
  };
}

export const googleBusinessExecutor = createGoogleBusinessExecution();
