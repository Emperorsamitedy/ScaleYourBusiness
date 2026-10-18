// The Meta write connector — P3-20g (Session D, layer D1), rules 13 and 18.
//
// HOW AN OWNER CONNECTS. The credential is a token plus asset ids: a
// Business Manager system-user token (or a long-lived token from the
// owner's own Meta app, pilot route 2) with the Page id and, optionally,
// the linked Instagram account id for publishing, or the ad account id for
// ad management. Publishing and ad management are two connections with two
// consents (`meta_publish`, `meta_ads`), each holding EXACTLY its registry
// scopes; one token with both sets of permissions connects as neither.
//
// PROVEN BEFORE STORED. The verifier asks /me/permissions (Meta reports
// scopes, so the check is real), refuses by name anything outside the
// registry before touching an asset, then proves the token reaches the
// asset: the Page (and a Page token can be had for it), the Instagram
// account, or the ad account. connectForExecution compares the scopes
// again, encrypts, stores. Nothing here logs or returns a token.
//
// THE PAGE TOKEN. Meta publishes to a Page with a Page token. Derived here
// from the system user's assigned Page by reading the Page's access_token
// field — _verify at build_ against a real Page: Meta's current docs do not
// state the derivation for system users. There is NO pasted-Page-token
// fallback (security review 2026-10-17): a pasted token's permissions
// can't be checked against the consent, so a broader token — or another
// user's — could have been stored under it. The only Page token SYB uses
// is one derived from the system-user token whose scopes were verified
// exactly. If derivation fails against a real Page, the paste route comes
// back only with a verified permission check (P3-21b).
//
// WHAT IT CAN SEND. Only the requests in META_EXEC_REQUESTS, all GET until
// the publish ops (P3-21b) and ad ops (P3-22b) land; meta.test.ts scans
// this source and fails the build otherwise. No registered path under
// act_* may name billing, funding or payment methods (rule 18).
//
// THE OPS. Registered in the scope registry so consent names them, built
// in D2 and D3. Until then every op refuses by name — never a silent no-op,
// and never a null undo, which the engine would read as "irreversible".

import type { MetaResponse } from "../../connectors/providers/meta-ads";
import { META_GRAPH_ORIGIN, META_IGNORED_PERMISSIONS } from "../../connectors/providers/meta-ads";
import type { MetaFailure } from "../meta-errors";
import { classifyMetaError } from "../meta-errors";
import type { CredentialVerifier } from "../verify";
import { ExecutionConnectionError, verifyExecutionScopes } from "../verify";
import { touchesMoneySurface } from "../scopes";
import type { ExecutionProvider } from "./fixture";

export const META_EXEC_API_VERSION = "v26.0";
export const META_EXEC_MAX_ATTEMPTS = 3;

export type MetaExecutionProviderId = "meta_publish" | "meta_ads";

/** Every request this module may send. The closed set the build gates read. */
export const META_EXEC_REQUESTS = {
  permissions: { method: "GET", path: "/me/permissions" },
  page: { method: "GET", path: "/{page_id}" },
  ig_user: { method: "GET", path: "/{ig_user_id}" },
  ad_account: { method: "GET", path: "/act_{ad_account_id}" },
} as const;

type MetaExecRequest = keyof typeof META_EXEC_REQUESTS;

export interface MetaRequestSpec {
  method: "GET";
  path: string;
}

/**
 * Rule 18 for paths: a registered request under an ad account that names
 * billing, funding or payment methods. An empty array is the only answer.
 */
export function auditMetaRequests(
  requests: Readonly<Record<string, MetaRequestSpec>> = META_EXEC_REQUESTS,
): string[] {
  return Object.values(requests)
    .filter((r) => r.path.startsWith("/act_") && touchesMoneySurface(r.path))
    .map((r) => `${r.method} ${r.path}`);
}

export interface MetaExecRequestInit {
  /** GET only until P3-21b widens it, deliberately and with the source scan. */
  method: "GET";
  headers: Record<string, string>;
}

export type MetaExecFetch = (url: string, init: MetaExecRequestInit) => Promise<MetaResponse>;

export interface MetaExecutionOptions {
  fetch?: MetaExecFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface MetaExecutionCredential {
  access_token: string;
  page_id: string | null;
  ig_user_id: string | null;
  /** Digits only; the act_ prefix is added where the API wants it. */
  ad_account_id: string | null;
}

function token(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const t = typeof value === "string" ? value.trim() : "";
  if (t === "" || /\s/.test(t)) {
    throw new ExecutionConnectionError(`meta: paste the ${what} all on one line`, 400);
  }
  return t;
}

function digits(value: unknown, what: string, strip?: RegExp): string | null {
  if (value === undefined || value === null || value === "") return null;
  const d = typeof value === "string" ? value.trim().replace(strip ?? /^$/, "") : "";
  if (!/^\d{5,}$/.test(d)) {
    throw new ExecutionConnectionError(`meta: the ${what} is a number`, 400);
  }
  return d;
}

export function parseMetaExecutionCredential(
  secret: string,
  provider: MetaExecutionProviderId,
): MetaExecutionCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new ExecutionConnectionError("meta: the token and the asset ids are both needed", 400);
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const cred: MetaExecutionCredential = {
    access_token: token(c["access_token"], "access token") ?? "",
    page_id: digits(c["page_id"], "Page id"),
    ig_user_id: digits(c["ig_user_id"], "Instagram account id"),
    ad_account_id: digits(c["ad_account_id"], "ad account id", /^act_/),
  };
  if (c["page_access_token"] !== undefined && c["page_access_token"] !== "") {
    throw new ExecutionConnectionError(
      "meta: a pasted Page token can't be checked against your consent — assign the Page to the system user instead, and SYB derives the Page token from it",
      400,
    );
  }
  if (cred.access_token === "") {
    throw new ExecutionConnectionError("meta: the access token is needed", 400);
  }
  if (provider === "meta_publish" && cred.page_id === null) {
    throw new ExecutionConnectionError("meta: publishing needs the id of the Page to post to", 400);
  }
  if (provider === "meta_ads" && cred.ad_account_id === null) {
    throw new ExecutionConnectionError(
      "meta: ad management needs the ad account id, the number in Ads Manager",
      400,
    );
  }
  return cred;
}

interface Context {
  fetch: MetaExecFetch;
  sleep: (ms: number) => Promise<void>;
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function pathFor(which: MetaExecRequest, ids: Readonly<Record<string, string>>): string {
  const path = META_EXEC_REQUESTS[which].path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const id = ids[name];
    if (id === undefined) throw new Error(`meta: ${which} needs ${name}`);
    return encodeURIComponent(id);
  });
  return `/${META_EXEC_API_VERSION}${path}`;
}

async function metaRequest(
  ctx: Context,
  bearer: string,
  which: MetaExecRequest,
  ids: Readonly<Record<string, string>>,
  params: Record<string, string>,
  cannotReach: string,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  const url = `${META_GRAPH_ORIGIN}${pathFor(which, ids)}${query ? `?${query}` : ""}`;

  for (let attempt = 1; ; attempt += 1) {
    let response: MetaResponse;
    try {
      response = await ctx.fetch(url, {
        method: META_EXEC_REQUESTS[which].method,
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
      });
    } catch {
      // A request that never got an answer: Meta unavailable, by the taxonomy.
      const failure = classifyMetaError({ status: 0, code: null });
      if (attempt >= META_EXEC_MAX_ATTEMPTS) throw new MetaRequestError(failure, cannotReach);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; error_subcode?: unknown };
    } | null;
    const error = body?.error;
    if (response.status === 200 && error === undefined && body !== null) {
      return body as Record<string, unknown>;
    }

    // One mapping for every refusal (P3-24a): the sentence, the connection's
    // fate, the next step and whether to retry all come from meta-errors.
    const failure = classifyMetaError({
      status: response.status,
      code: typeof error?.code === "number" ? error.code : null,
      subcode: typeof error?.error_subcode === "number" ? error.error_subcode : null,
    });
    if (failure.retryable && attempt < META_EXEC_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    throw new MetaRequestError(failure, cannotReach);
  }
}

const STATUS_FOR: Readonly<Record<MetaFailure["kind"], number>> = {
  auth: 422,
  permission: 422,
  rate_limit: 503,
  page_limit: 503,
  unavailable: 503,
  unknown: 502,
};

/**
 * A Meta refusal, classified once. The message is the owner's sentence —
 * with the asset named where that helps fix it — and `failure` carries the
 * connection's fate and the next step for the degrade-to-paused path (P3-24b).
 */
export class MetaRequestError extends ExecutionConnectionError {
  readonly failure: MetaFailure;
  constructor(failure: MetaFailure, asset: string) {
    super(
      failure.kind === "permission"
        ? `${failure.owner_sentence} (It can't reach ${asset}.)`
        : failure.owner_sentence,
      STATUS_FOR[failure.kind],
    );
    this.name = "MetaRequestError";
    this.failure = failure;
  }
}

/** What Meta says the token was granted, public_profile aside. */
async function grantedPermissions(ctx: Context, accessToken: string): Promise<string[]> {
  const body = await metaRequest(ctx, accessToken, "permissions", {}, {}, "its own permissions");
  const data = Array.isArray(body["data"]) ? body["data"] : null;
  if (data === null) {
    throw new ExecutionConnectionError("meta: could not read the token's permissions", 502);
  }
  return [
    ...new Set(
      data.flatMap((p) => {
        const perm = p as { permission?: unknown; status?: unknown } | null;
        return typeof perm?.permission === "string" &&
          perm.status === "granted" &&
          !META_IGNORED_PERMISSIONS.has(perm.permission)
          ? [perm.permission]
          : [];
      }),
    ),
  ].sort();
}

function sameId(body: Record<string, unknown>, expected: string, what: string): void {
  if (String(body["id"] ?? "").replace(/^act_/, "") !== expected) {
    throw new ExecutionConnectionError(`meta: the ${what} answered with a different id`, 502);
  }
}

async function provePage(ctx: Context, cred: MetaExecutionCredential, pageId: string) {
  const reach = `Page ${pageId}. Assign the Page to the system user with the permissions listed`;
  const page = await metaRequest(
    ctx,
    cred.access_token,
    "page",
    { page_id: pageId },
    { fields: "id,name,access_token" },
    reach,
  );
  sameId(page, pageId, "Page");
  if (typeof page["access_token"] !== "string" || page["access_token"] === "") {
    throw new ExecutionConnectionError(
      `meta: no Page token could be had for Page ${pageId}. Assign the Page to the system user with the permissions listed`,
      422,
    );
  }
}

export interface MetaExecution {
  /** The connect-time proof for one of the two Meta consents. */
  verifier(provider: MetaExecutionProviderId): CredentialVerifier;
  publish: ExecutionProvider;
  ads: ExecutionProvider;
}

export class MetaOpNotBuiltError extends Error {
  constructor(provider: MetaExecutionProviderId, op: string, task: string) {
    super(
      `${provider}: "${op}" is registered but not built yet (${task}) — nothing was sent to Meta`,
    );
    this.name = "MetaOpNotBuiltError";
  }
}

function unbuilt(id: MetaExecutionProviderId, task: string): ExecutionProvider {
  const refuse = (op: string): never => {
    throw new MetaOpNotBuiltError(id, op, task);
  };
  return {
    id,
    captureUndo: async (op) => refuse(op),
    execute: async (op) => refuse(op),
    undo: async (op) => refuse(op),
  };
}

const defaultFetch: MetaExecFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function createMetaExecution(options: MetaExecutionOptions = {}): MetaExecution {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    verifier: (provider) => async (secret) => {
      const cred = parseMetaExecutionCredential(secret, provider);
      const granted = await grantedPermissions(ctx, cred.access_token);
      // Refused by name before any asset is touched; connectForExecution checks again.
      verifyExecutionScopes(provider, granted);

      if (provider === "meta_publish") {
        await provePage(ctx, cred, cred.page_id as string);
        if (cred.ig_user_id !== null) {
          const ig = await metaRequest(
            ctx,
            cred.access_token,
            "ig_user",
            { ig_user_id: cred.ig_user_id },
            { fields: "id,username" },
            `Instagram account ${cred.ig_user_id}. Link it to the Page and assign it to the system user`,
          );
          sameId(ig, cred.ig_user_id, "Instagram account");
        }
      } else {
        const account = cred.ad_account_id as string;
        const body = await metaRequest(
          ctx,
          cred.access_token,
          "ad_account",
          { ad_account_id: account },
          { fields: "id,name,currency" },
          `ad account act_${account}. Assign the ad account to the system user with ads_management`,
        );
        sameId(body, account, "ad account");
      }
      return { granted_scopes: granted };
    },
    publish: unbuilt("meta_publish", "P3-21b"),
    ads: unbuilt("meta_ads", "P3-22b"),
  };
}

export const metaExecution = createMetaExecution();
export const metaPublishExecutor = metaExecution.publish;
export const metaAdsExecutor = metaExecution.ads;
