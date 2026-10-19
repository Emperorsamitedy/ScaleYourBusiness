// Fail-fast environment access. Import { env } from "@/lib/env" — never
// read process.env directly outside this file. Missing required variables
// throw at first access, not at the point of use three modules later.

type RequiredKey = "DATABASE_URL" | "ANTHROPIC_API_KEY" | "CONNECTOR_KEY" | "BLOB_READ_WRITE_TOKEN";

function read(key: RequiredKey): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${key} — copy .env.example to .env and fill it in`,
    );
  }
  return value;
}

// Lazy per-key access so code paths that never touch the Anthropic API
// (everything before Session L) don't demand the key at import time.
export const env: Record<RequiredKey, string> = {
  get DATABASE_URL() {
    return read("DATABASE_URL");
  },
  get ANTHROPIC_API_KEY() {
    return read("ANTHROPIC_API_KEY");
  },
  // Phase 2 (P2-03): the key that encrypts connection secrets at rest.
  // Demanded only when a connector is connected or synced.
  get CONNECTOR_KEY() {
    return read("CONNECTOR_KEY");
  },
  // Phase 3 Session D (P3-20c): the Vercel Blob store that holds rendered
  // media at a public URL for the platform to fetch. Demanded only when a
  // render is attached to a content item; tests use the in-memory store.
  get BLOB_READ_WRITE_TOKEN() {
    return read("BLOB_READ_WRITE_TOKEN");
  },
};

export type MetaAccessLevel = "standard" | "advanced";

/**
 * P3-20i: what Meta has approved SYB for. Optional, and anything but
 * "advanced" reads as "standard" — the screen must never claim an access
 * level Meta hasn't granted, so the safe reading is the default.
 */
export function metaAccessLevel(): MetaAccessLevel {
  return process.env.META_ACCESS_LEVEL === "advanced" ? "advanced" : "standard";
}

/** APP_URL, the absolute origin for links and OAuth redirects. Null = derive from the request. */
export function appUrl(): string | null {
  return process.env.APP_URL?.trim() || null;
}

/** SYB's own Meta app for Facebook Login (P3-20j), as the environment holds it. */
export interface MetaLoginEnv {
  app_id: string;
  app_secret: string;
  /** META_OAUTH_REDIRECT_URI when set; otherwise derived from APP_URL or the request's origin. */
  redirect_uri: string | null;
  /** APP_URL when set: the origin the callback sends the owner back to. */
  app_url: string | null;
}

/**
 * P3-20j: Facebook Login is offered only when BOTH META_APP_ID and
 * META_APP_SECRET are set. Null otherwise — and every route of the flow
 * refuses rather than sending a half-configured request to Meta.
 */
export function metaLoginEnv(): MetaLoginEnv | null {
  const app_id = process.env.META_APP_ID?.trim() ?? "";
  const app_secret = process.env.META_APP_SECRET?.trim() ?? "";
  if (app_id === "" || app_secret === "") return null;
  return {
    app_id,
    app_secret,
    redirect_uri: process.env.META_OAUTH_REDIRECT_URI?.trim() || null,
    app_url: appUrl(),
  };
}

/**
 * THE REAL-WRITE GATE (Session D, D2's done-when). The first real publish
 * waits for Phase 2's two-week unattended clock to complete
 * (TASKS-PHASE3.md, "The gate, amended"). Until SESSION_D_REAL_WRITES is
 * exactly "on", the engine refuses every op of a provider that writes to a
 * real platform — before anything is claimed or sent — and the proposal
 * stays approved. Anything but "on" reads as off: the safe reading is the
 * default, as with META_ACCESS_LEVEL.
 */
export function sessionDRealWritesOn(): boolean {
  return process.env.SESSION_D_REAL_WRITES?.trim() === "on";
}
