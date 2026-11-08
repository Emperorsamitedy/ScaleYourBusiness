// P6-06 at the door (rule 28 amended): per-person figures are the owner's
// alone. A manager or a viewer is refused reading them as much as changing
// them, and the refusal carries no figure; the owner gets them, and with
// the team module off (the default) only that it is off. The session
// lookup is stubbed (it reads request cookies); the business is real.

import "dotenv/config";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { Access } from "../../../../lib/auth/access";
import type { Role } from "../../../../lib/auth/role-actions";
import { db } from "../../../../db";
import { accountModules } from "../../../../db/schema";
import { bootstrapIntake } from "../../../../lib/intake/service";
import { TEAM_MODULE } from "../../../../lib/team/module";

const resolveAccess = vi.fn<() => Promise<Access | null>>(async () => null);
vi.mock("../../../../lib/auth/access", () => ({ resolveAccess }));

const { DELETE, GET, POST } = await import("./route");

async function as(role: Role, on = true): Promise<Access> {
  const boot = await bootstrapIntake();
  if (on) {
    await db
      .insert(accountModules)
      .values({ account_id: boot.account_id, module: TEAM_MODULE, enabled: true });
  }
  return {
    ...boot,
    owned: true,
    session: {
      account_id: boot.account_id,
      profile_id: boot.profile_id,
      user_id: "00000000-0000-4000-8000-000000000001",
      email: "someone@example.test",
      role,
    } as Access["session"],
  };
}

const body = (method: string, data: unknown) =>
  new NextRequest("http://localhost/api/team/people", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

describe("/api/team/people — the owner role only", () => {
  it("refuses without a session", async () => {
    resolveAccess.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
  });

  for (const role of ["manager", "viewer"] as const) {
    it(`refuses a ${role} the figures, and says only why`, async () => {
      resolveAccess.mockResolvedValueOnce(await as(role));
      const res = await GET();
      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(["error", "needs", "role"]);
      expect(json.needs).toBe("owner");
    });

    it(`refuses a ${role} stating a capacity or removing a person`, async () => {
      resolveAccess.mockResolvedValueOnce(await as(role));
      expect((await POST(body("POST", { person: "Marta", per_week: 10 }))).status).toBe(403);
      resolveAccess.mockResolvedValueOnce(await as(role));
      expect((await DELETE(body("DELETE", { person: "Marta" }))).status).toBe(403);
    });
  }

  it("tells the owner the module is off, and nothing more, while it is off", async () => {
    resolveAccess.mockResolvedValueOnce(await as("owner", false));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("gives the owner the figures' view with the module on", async () => {
    resolveAccess.mockResolvedValueOnce(await as("owner"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, status: "no_bookings" });
  });

  it("asks the owner for a person and a whole capacity in the body", async () => {
    resolveAccess.mockResolvedValueOnce(await as("owner"));
    expect((await POST(body("POST", { per_week: 10 }))).status).toBe(400);
    resolveAccess.mockResolvedValueOnce(await as("owner"));
    expect((await POST(body("POST", { person: "Marta", per_week: 0 }))).status).toBe(400);
    resolveAccess.mockResolvedValueOnce(await as("owner"));
    expect((await POST(body("POST", { person: "Marta", per_week: 10 }))).status).toBe(404);
    resolveAccess.mockResolvedValueOnce(await as("owner"));
    expect((await DELETE(body("DELETE", { person: "Marta" }))).status).toBe(404);
  });
});
