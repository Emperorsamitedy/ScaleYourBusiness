// I-52.3: the role table, every action against every role, written out a
// second time here from the plan (TASKS-FEEDBACK.md, idea 52) rather than
// derived from the table — so a row that drifts fails, whichever side moved.

import { describe, expect, it } from "vitest";
import type { Role, RoleAction } from "./roles";
import {
  ROLES,
  ROLE_ACTIONS,
  ROLE_ACTION_KEYS,
  isRole,
  isRoleAction,
  permissionsFor,
  refusalFor,
  requireRole,
  roleAllows,
  roleOf,
} from "./roles";
import type { AuthedSession } from "./service";

/** The plan: a viewer reads and presses stop; and asks the chat (I-52c, owner 2026-11-01). */
const VIEWER_MAY: readonly RoleAction[] = [
  "stop.press",
  "intake.open",
  "telemetry.record",
  "alerts.remove_device",
  "chat.ask",
  // L-1: the language you read SYB in is your own.
  "language.own",
];
/** The plan: a manager approves or declines, drafts, answers support and presses stop. */
const MANAGER_MAY: readonly RoleAction[] = [
  ...VIEWER_MAY,
  "proposals.decide",
  "proposals.generate",
  "proposals.carry_out",
  "content.draft",
  "support.answer",
  // Decision 2 (owner, 2026-11-09): call transcripts and messages are for those who answer support.
  "phone.transcripts",
  "alerts.subscribe",
  "reviews.answer",
  // I-52b (owner, 2026-11-01): the pipeline's day-to-day, and reading a connection again.
  "pipeline.edit",
  "connections.sync",
];
/** And what the plan names as never a manager's — each must be owner-only. */
const NEVER_A_MANAGER: readonly RoleAction[] = [
  "connections.manage",
  "write_access.manage",
  "profile.edit", // hard limits are the 13.5 answer, a profile fact
  "billing.manage",
  "erasure.run",
  "team.manage",
  // P6-06 (rule 28 amended): per-person figures, read or changed, are the owner's alone.
  "people.read",
  "people.manage",
  "rules.manage",
  // L-1: the business's language and currency.
  "business.locale",
  // P6-05 (rule 26 amended): preparing, approving and marking payments is the owner's.
  "payments.prepare",
  // Least privilege (owner, 2026-11-09): the payments list and the bank files too.
  "payments.read",
  // P6-08 (rule 32): call recordings are heard by the owner alone.
  "phone.recordings",
  // Architecture-v2 D7: whether the business's figures join peer benchmarks.
  "peers.consent",
  // The v1 spec §4: what SYB may do on its own.
  "ladder.manage",
];

const session = (role: Role): AuthedSession => ({
  account_id: "a",
  user_id: "u",
  email: "x@example.com",
  profile_id: "p",
  role,
});

describe("ROLE_ACTIONS — every action, every role", () => {
  it("an owner may do everything", () => {
    for (const a of ROLE_ACTION_KEYS) expect(roleAllows("owner", a), a).toBe(true);
  });

  it("a manager may do exactly the plan's list, and nothing else", () => {
    for (const a of ROLE_ACTION_KEYS) {
      expect(roleAllows("manager", a), a).toBe(MANAGER_MAY.includes(a));
    }
  });

  it("a viewer may read and press stop, and nothing else", () => {
    for (const a of ROLE_ACTION_KEYS) {
      expect(roleAllows("viewer", a), a).toBe(VIEWER_MAY.includes(a));
    }
  });

  it("keeps rule 13's consent, the team, billing, erasure and limits with the owner", () => {
    for (const a of NEVER_A_MANAGER) {
      expect(ROLE_ACTIONS[a].min, a).toBe("owner");
      expect(roleAllows("manager", a), a).toBe(false);
    }
  });

  it("lets every role press the emergency stop, and only an owner start again", () => {
    for (const r of ROLES) expect(roleAllows(r, "stop.press")).toBe(true);
    expect(roleAllows("owner", "stop.resume")).toBe(true);
    expect(roleAllows("manager", "stop.resume")).toBe(false);
    expect(roleAllows("viewer", "stop.resume")).toBe(false);
  });

  it("has words for every action, and the lists above name only real actions", () => {
    for (const a of ROLE_ACTION_KEYS) {
      const row = ROLE_ACTIONS[a];
      expect(isRole(row.min), a).toBe(true);
      expect(row.what.trim().length, a).toBeGreaterThan(5);
      expect(row.what, a).not.toMatch(/[.]$/);
    }
    for (const a of [...MANAGER_MAY, ...NEVER_A_MANAGER]) expect(isRoleAction(a), a).toBe(true);
    expect(isRoleAction("connections.manage")).toBe(true);
    expect(isRoleAction("connections.steal")).toBe(false);
    expect(isRole("admin")).toBe(false);
  });

  it("permissionsFor is the table, read for one role", () => {
    const viewer = permissionsFor("viewer");
    expect(Object.keys(viewer).sort()).toEqual([...ROLE_ACTION_KEYS].sort());
    expect(viewer["stop.press"]).toBe(true);
    expect(viewer["proposals.decide"]).toBe(false);
  });
});

describe("refusalFor — the sentence a refused person reads", () => {
  it("names the least role that may, in plain words", () => {
    expect(refusalFor("connections.manage")).toBe(
      "Only an owner can connect or disconnect accounts.",
    );
    expect(refusalFor("proposals.decide")).toBe(
      "Only an owner or a manager can approve or decline proposals.",
    );
  });
});

describe("roleOf / requireRole — the one check", () => {
  it("reads a session's role", () => {
    expect(roleOf(session("manager"))).toBe("manager");
    expect(roleOf({ owned: true, session: session("viewer") })).toBe("viewer");
  });

  it("treats the anonymous interview (a business nobody owns yet) as its owner", () => {
    expect(roleOf({ owned: false, session: null })).toBe("owner");
  });

  it("gives an owned business with no matching session no role at all", () => {
    expect(roleOf({ owned: true, session: null })).toBeNull();
    expect(roleOf(null)).toBeNull();
  });

  it("lets an allowed role through", () => {
    expect(requireRole(session("manager"), "proposals.decide")).toBeNull();
    expect(requireRole(session("viewer"), "stop.press")).toBeNull();
    expect(requireRole({ owned: false, session: null }, "profile.edit")).toBeNull();
  });

  it("refuses a role that may not with 403 and the reason", async () => {
    const res = requireRole(session("manager"), "connections.manage");
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      error: "Only an owner can connect or disconnect accounts.",
      needs: "owner",
      role: "manager",
    });
    expect(requireRole(session("viewer"), "proposals.decide")?.status).toBe(403);
  });

  it("refuses nobody-signed-in with 401", () => {
    expect(requireRole(null, "stop.press")?.status).toBe(401);
    expect(requireRole({ owned: true, session: null }, "stop.press")?.status).toBe(401);
  });
});
