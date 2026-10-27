// P5-18 at the door: /api/team answers 401 without a session, and with the
// team module off (the default) it says so and carries nothing else. The
// session lookup is stubbed (it reads request cookies); the account is real.

import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { bootstrapIntake } from "../../../lib/intake/service";

const resolveAccess = vi.fn<() => Promise<{ account_id: string; profile_id: string } | null>>(
  async () => null,
);
vi.mock("../../../lib/auth/access", () => ({ resolveAccess }));

const { GET } = await import("./route");

describe("GET /api/team", () => {
  it("refuses without a session", async () => {
    resolveAccess.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
  });

  it("says the module is off, and nothing more, for a business that never switched it on", async () => {
    const boot = await bootstrapIntake();
    resolveAccess.mockResolvedValueOnce(boot);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
