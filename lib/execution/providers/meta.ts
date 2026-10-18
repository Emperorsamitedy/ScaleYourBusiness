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
// WHAT IT CAN SEND. Only the requests in META_EXEC_REQUESTS; meta.test.ts
// scans this source and fails the build otherwise. Every one is a read
// except the OAuth token exchange (P3-20j, Facebook Login for testers),
// which trades a sign-in code or a short-lived token for a user token and
// changes nothing on any Page or ad account. It is sent as a form body, so
// the app secret and the code never sit in a URL. The publish ops (P3-21b)
// and ad ops (P3-22b) widen the list when they land. No registered path
// under act_* may name billing, funding or payment methods (rule 18).
//
// FACEBOOK LOGIN (P3-20j). The same helper — the same retry cap, timeout
// and error taxonomy — serves the tester sign-in: the code exchange, the
// long-lived swap, and the two candidate lists (/me/accounts for Pages and
// their linked Instagram accounts, /me/adaccounts). The token it yields
// goes through the same verifier and connectForExecution as a pasted one.
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
/** Every request to Meta gives up after this long; a timeout counts as "Meta didn't answer". */
export const META_EXEC_TIMEOUT_MS = 20_000;

export type MetaExecutionProviderId = "meta_publish" | "meta_ads";

/** Every request this module may send. The closed set the build gates read. */
export const META_EXEC_REQUESTS = {
  permissions: { method: "GET", path: "/me/permissions" },
  page: { method: "GET", path: "/{page_id}" },
  ig_user: { method: "GET", path: "/{ig_user_id}" },
  ad_account: { method: "GET", path: "/act_{ad_account_id}" },
  // P3-20j, Facebook Login: the token exchange (code grant and long-lived swap), then the lists.
  token_exchange: { method: "POST", path: "/oauth/access_token" },
  my_pages: { method: "GET", path: "/me/accounts" },
  my_ad_accounts: { method: "GET", path: "/me/adaccounts" },
} as const;

type MetaExecRequest = keyof typeof META_EXEC_REQUESTS;

export interface MetaRequestSpec {
  method: "GET" | "POST";
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
  /** A registered request's own method; the only non-GET is the OAuth token exchange. */
  method: MetaRequestSpec["method"];
  headers: Record<string, string>;
  /** Form-encoded, for the token exchange only. */
  body?: string;
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

/** How a request authenticates: the token in a header, or (token exchange only) a form body. */
type MetaAuth = { bearer: string } | { form: Readonly<Record<string, string>> };

async function metaRequest(
  ctx: Context,
  auth: MetaAuth,
  which: MetaExecRequest,
  ids: Readonly<Record<string, string>>,
  params: Record<string, string>,
  cannotReach: string,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  const url = `${META_GRAPH_ORIGIN}${pathFor(which, ids)}${query ? `?${query}` : ""}`;
  const init: MetaExecRequestInit =
    "bearer" in auth
      ? {
          method: META_EXEC_REQUESTS[which].method,
          headers: { authorization: `Bearer ${auth.bearer}`, accept: "application/json" },
        }
      : {
          method: META_EXEC_REQUESTS[which].method,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams(auth.form).toString(),
        };

  for (let attempt = 1; ; attempt += 1) {
    let response: MetaResponse;
    try {
      response = await ctx.fetch(url, init);
    } catch {
      // A request that never got an answer (or timed out): Meta unavailable, by the taxonomy.
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
  const body = await metaRequest(
    ctx,
    { bearer: accessToken },
    "permissions",
    {},
    {},
    "its own permissions",
  );
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
    { bearer: cred.access_token },
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

/** SYB's own Meta app, for the tester sign-in. The secret never leaves the server. */
export interface MetaAppCredentials {
  app_id: string;
  app_secret: string;
}

/** A Page the signed-in Facebook user can publish to, with its linked Instagram account. */
export interface MetaPageCandidate {
  id: string;
  name: string;
  instagram: { id: string; username: string | null } | null;
}

/** An ad account the signed-in Facebook user can manage. account_status 1 is active. */
export interface MetaAdAccountCandidate {
  /** Digits only, as the credential stores it. */
  id: string;
  name: string;
  account_status: number | null;
}

/** P3-20j: the Graph calls behind Facebook Login, through the same capped, timed helper. */
export interface MetaLoginCalls {
  /** The sign-in code for a short-lived user token. */
  exchangeCode(app: MetaAppCredentials, code: string, redirectUri: string): Promise<string>;
  /** A short-lived user token for a long-lived one (about 60 days). */
  longLived(app: MetaAppCredentials, shortLived: string): Promise<string>;
  pages(userToken: string): Promise<MetaPageCandidate[]>;
  adAccounts(userToken: string): Promise<MetaAdAccountCandidate[]>;
}

export interface MetaExecution {
  /** The connect-time proof for one of the two Meta consents. */
  verifier(provider: MetaExecutionProviderId): CredentialVerifier;
  /** Facebook Login for testers (P3-20j). */
  login: MetaLoginCalls;
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
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(META_EXEC_TIMEOUT_MS),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

function userToken(body: Record<string, unknown>): string {
  const t = body["access_token"];
  if (typeof t !== "string" || t === "" || /\s/.test(t)) {
    throw new ExecutionConnectionError("meta: the Facebook sign-in returned no usable token", 502);
  }
  return t;
}

function listOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const data = body["data"];
  if (!Array.isArray(data)) {
    throw new ExecutionConnectionError("meta: the list came back in a shape SYB can't read", 502);
  }
  return data.filter((d): d is Record<string, unknown> => d !== null && typeof d === "object");
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" && /^\d{5,}$/.test(v) ? v : null;
const nameOf = (v: unknown): string => (typeof v === "string" && v.trim() !== "" ? v : "(no name)");

function loginCalls(ctx: Context): MetaLoginCalls {
  const exchange = async (form: Record<string, string>) =>
    userToken(await metaRequest(ctx, { form }, "token_exchange", {}, {}, "the Facebook sign-in"));
  return {
    exchangeCode: (app, code, redirectUri) =>
      exchange({
        client_id: app.app_id,
        client_secret: app.app_secret,
        redirect_uri: redirectUri,
        code,
      }),
    longLived: (app, shortLived) =>
      exchange({
        grant_type: "fb_exchange_token",
        client_id: app.app_id,
        client_secret: app.app_secret,
        fb_exchange_token: shortLived,
      }),
    pages: async (token) => {
      const body = await metaRequest(
        ctx,
        { bearer: token },
        "my_pages",
        {},
        { fields: "id,name,instagram_business_account{id,username}", limit: "100" },
        "your Pages",
      );
      return listOf(body).flatMap((p) => {
        const id = idOf(p["id"]);
        if (id === null) return [];
        const ig = p["instagram_business_account"];
        const igRow =
          ig !== null && typeof ig === "object" ? (ig as Record<string, unknown>) : null;
        const igId = igRow ? idOf(igRow["id"]) : null;
        const username = igRow?.["username"];
        return [
          {
            id,
            name: nameOf(p["name"]),
            instagram:
              igId === null
                ? null
                : { id: igId, username: typeof username === "string" ? username : null },
          },
        ];
      });
    },
    adAccounts: async (token) => {
      const body = await metaRequest(
        ctx,
        { bearer: token },
        "my_ad_accounts",
        {},
        { fields: "id,name,account_status", limit: "100" },
        "your ad accounts",
      );
      return listOf(body).flatMap((a) => {
        const raw = a["id"];
        const id = typeof raw === "string" ? idOf(raw.replace(/^act_/, "")) : null;
        if (id === null) return [];
        const status = a["account_status"];
        return [
          {
            id,
            name: nameOf(a["name"]),
            account_status: typeof status === "number" ? status : null,
          },
        ];
      });
    },
  };
}

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
            { bearer: cred.access_token },
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
          { bearer: cred.access_token },
          "ad_account",
          { ad_account_id: account },
          { fields: "id,name,currency" },
          `ad account act_${account}. Assign the ad account to the system user with ads_management`,
        );
        sameId(body, account, "ad account");
      }
      return { granted_scopes: granted };
    },
    login: loginCalls(ctx),
    publish: unbuilt("meta_publish", "P3-21b"),
    ads: unbuilt("meta_ads", "P3-22b"),
  };
}

export const metaExecution = createMetaExecution();
export const metaPublishExecutor = metaExecution.publish;
export const metaAdsExecutor = metaExecution.ads;
