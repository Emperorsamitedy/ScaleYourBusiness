// I-52.3, held structurally: every mutating handler (POST, PUT, PATCH,
// DELETE) of every route under app/api calls requireRole — the one role
// check (lib/auth/roles) — or is named below with the reason it has none.
// A new route that writes without asking who's asking fails this test.
//
// HOW TO FIX A FAILURE
//   · The route acts for a signed-in business: inside the handler, after
//     the access/session is known, add
//         const denied = requireRole(access, "<action>");
//         if (denied) return denied;
//     with an action from ROLE_ACTIONS in lib/auth/roles.ts. When none
//     fits, add a row there — `min: "owner"` when unsure (the stricter
//     reading) — and roles.test.ts's lists will ask you to place it.
//   · The route has its own credential and no business session (a webhook
//     signature, a cron or ops secret, a token link), or is a step of
//     signing in: add it to ALLOWED below, with the reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isRoleAction } from "../../lib/auth/roles";

const ROOT = join(process.cwd(), "app", "api");

/** route file (relative to app/api, forward slashes) → method → why it has no role check. */
export const ALLOWED: Record<string, Partial<Record<Method, string>>> = {
  "auth/login/route.ts": { POST: "sign-in: asks for a link; nobody is signed in yet" },
  "auth/redeem/route.ts": { POST: "sign-in: redeems a link; nobody is signed in yet" },
  "auth/logout/route.ts": { POST: "ends this browser's own session; changes no business" },
  "auth/oauth/[provider]/callback/route.ts": { POST: "sign-in: the provider proves the email" },
  "auth/switch/route.ts": {
    POST: "identity: moves to the person's own other business, checked against the verified email",
  },
  "auth/business/route.ts": {
    POST: "identity: makes a NEW business the person owns; nothing in this one changes",
  },
  "members/join/route.ts": {
    POST: "joining: not on the team yet — the invite and the exact verified address are the check",
  },
  "intake/route.ts": { DELETE: "clears this browser's interview cookie; changes no data" },
  "support/public/route.ts": {
    POST: "the public widget: strangers on the owner's site, a site key and a conversation token",
  },
  "support/inbound/route.ts": {
    POST: "Resend's inbound webhook, Svix-signed — support mail and idea 45's r-<token> review mail alike",
  },
  "email/events/route.ts": { POST: "Resend's delivery-events webhook, Svix-signed" },
  "phone/voice/route.ts": {
    POST: "Twilio's voice webhook, X-Twilio-Signature: a stranger's call, no business session (P6-02)",
  },
  "stripe/webhook/route.ts": { POST: "Stripe's webhook, signature-verified" },
  "u/[token]/route.ts": { POST: "one-click unsubscribe: the signed token is the credential" },
  "summary/stop/[token]/route.ts": {
    POST: "one-click stop of the weekly summary: the signed token is the credential",
  },
  "ops/campaign-review/route.ts": { POST: "the operator panel: OPS_KEY, not a business session" },
  "ops/law-review/route.ts": { POST: "the operator panel: OPS_KEY, not a business session" },
};

/** GET handlers that change something anyway, held to the same rule. */
export const MUTATING_GETS: readonly string[] = [
  "connections/meta/callback/route.ts", // finishes a write-access consent (rule 13)
  "connections/google-business/callback/route.ts", // I-45a: finishes the Google consent (rule 13)
];

type Method = "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
const MUTATING: readonly Method[] = ["POST", "PUT", "PATCH", "DELETE"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Pure: each exported handler's own text — from its export to the next top-level export. */
export function handlers(source: string): { method: Method; body: string }[] {
  const re = /^export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/gm;
  const found = [...source.matchAll(re)];
  return found.map((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < found.length ? (found[i + 1]?.index ?? source.length) : source.length;
    const rest = source.slice(start, end);
    const next = rest.slice(1).search(/^export\s/m);
    return { method: m[1] as Method, body: next === -1 ? rest : rest.slice(0, next + 1) };
  });
}

/** Pure: the handlers in one file that should check a role and don't. */
export function unguarded(
  source: string,
  allowed: Partial<Record<Method, string>> = {},
  alsoGet = false,
): Method[] {
  return handlers(source)
    .filter((h) => MUTATING.includes(h.method) || (alsoGet && h.method === "GET"))
    .filter((h) => !allowed[h.method])
    .filter((h) => !/\brequireRole\(/.test(h.body))
    .map((h) => h.method);
}

const files = walk(ROOT).map((p) => ({
  rel: relative(ROOT, p).split(sep).join("/"),
  source: readFileSync(p, "utf8"),
}));

describe("the checker itself", () => {
  const guarded = `export async function POST() {\n  const denied = requireRole(access, "stop.press");\n  if (denied) return denied;\n}\n`;
  const open = `export async function GET() { return ok; }\nexport async function PUT() {\n  await write();\n}\nexport const DELETE = async () => requireRole(a, "team.manage");\n`;

  it("passes a handler that calls requireRole", () => {
    expect(unguarded(guarded)).toEqual([]);
  });

  it("fails a mutating handler that doesn't, and ignores a plain GET", () => {
    expect(unguarded(open)).toEqual(["PUT"]);
    expect(unguarded(open, { PUT: "a webhook" })).toEqual([]);
    expect(unguarded(open, {}, true)).toEqual(["GET", "PUT"]);
  });

  it("doesn't let one handler's call cover the next one", () => {
    const two = `export async function POST() {\n  requireRole(a, "stop.press");\n}\nexport async function DELETE() {\n  await stop();\n}\n`;
    expect(unguarded(two)).toEqual(["DELETE"]);
  });
});

describe("every mutating route under app/api checks the role", () => {
  it("finds the routes (the scan is looking in the right place)", () => {
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((f) => f.rel === "proposals/route.ts")).toBe(true);
  });

  it("has requireRole in every POST, PUT, PATCH and DELETE handler, or a listed reason", () => {
    const missing = files.flatMap((f) =>
      unguarded(f.source, ALLOWED[f.rel] ?? {}, MUTATING_GETS.includes(f.rel)).map(
        (m) => `app/api/${f.rel} ${m}`,
      ),
    );
    expect(
      missing,
      `These handlers change something without asking who's asking. Add\n` +
        `  const denied = requireRole(access, "<action from lib/auth/roles ROLE_ACTIONS>");\n` +
        `  if (denied) return denied;\n` +
        `or, for a webhook/cron/token link/sign-in step, list it in ALLOWED in app/api/role-wiring.test.ts with its reason:\n  ` +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("uses only actions that exist in ROLE_ACTIONS", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of f.source.matchAll(/requireRole\([^,()]+,\s*"([^"]+)"\)/g)) {
        if (!isRoleAction(m[1])) bad.push(`app/api/${f.rel}: ${m[1]}`);
      }
      // The per-action maps (PIPELINE_ROLE, SUPPORT_ROLE, …) and their fallbacks.
      for (const block of f.source.matchAll(/_ROLE: Record<string, RoleAction> = \{([^}]*)\}/g)) {
        for (const v of (block[1] ?? "").matchAll(/:\s*"([^"]+)"/g)) {
          if (!isRoleAction(v[1])) bad.push(`app/api/${f.rel}: ${v[1]}`);
        }
      }
      for (const v of f.source.matchAll(/_ROLE\[[^\]]+\] \?\? "([^"]+)"/g)) {
        if (!isRoleAction(v[1])) bad.push(`app/api/${f.rel}: ${v[1]}`);
      }
    }
    expect(bad, "an action that isn't a row of ROLE_ACTIONS (lib/auth/roles.ts)").toEqual([]);
  });

  it("lists no route or method that doesn't exist, each with a reason", () => {
    for (const [rel, methods] of Object.entries(ALLOWED)) {
      const file = files.find((f) => f.rel === rel);
      expect(
        file,
        `ALLOWED names app/api/${rel}, which is gone — take it off the list`,
      ).toBeTruthy();
      const has = handlers(file?.source ?? "").map((h) => h.method);
      for (const [m, why] of Object.entries(methods)) {
        expect(has, `app/api/${rel} has no ${m} any more — take it off ALLOWED`).toContain(m);
        expect((why ?? "").length).toBeGreaterThan(10);
      }
    }
    for (const rel of MUTATING_GETS)
      expect(
        files.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
  });
});
