// Least privilege at the door (the owner's decision of 2026-11-09): every
// payments route — the list, every action, a new file and a file again — is
// the owner's. A manager or a viewer gets the role refusal and nothing is
// read or written: the session lookup is stubbed, and the payments modules
// are stubbed so a call that slipped past the check would show.

import "dotenv/config";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Access } from "../../../lib/auth/access";
import type { Role } from "../../../lib/auth/role-actions";

const resolveAccess = vi.fn<() => Promise<Access | null>>(async () => null);
vi.mock("../../../lib/auth/access", () => ({ resolveAccess }));

const touched = vi.fn();
const stub =
  (name: string, value: unknown = null) =>
  async () => {
    touched(name);
    return value;
  };
vi.mock("../../../lib/payments/store", () => ({
  PaymentDraftError: class extends Error {},
  currentPayer: stub("currentPayer"),
  listPayments: stub("listPayments", []),
  payableThings: stub("payableThings", { suppliers: [], fixed_costs: [] }),
  readyPayments: stub("readyPayments", []),
  draftPaymentProposal: stub("draftPaymentProposal"),
  statePayer: stub("statePayer"),
  markPaidInBank: stub("markPaidInBank"),
  eraseBankDetails: stub("eraseBankDetails", 0),
}));
vi.mock("../../../lib/payments/exports", () => ({
  ExportError: class extends Error {},
  listExports: stub("listExports", []),
  exportNewFile: stub("exportNewFile"),
  exportAgain: stub("exportAgain"),
}));

const list = await import("./route");
const file = await import("./file/route");

const PROFILE = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";

const as = (role: Role): Access => ({
  profile_id: PROFILE,
  account_id: "acc",
  owned: true,
  session: {
    account_id: "acc",
    user_id: "u",
    email: "someone@test.local",
    profile_id: PROFILE,
    role,
  },
});

const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** Every door into payments, each with a request that would otherwise do something. */
const DOORS: { name: string; call: () => Promise<Response> }[] = [
  { name: "GET /api/payments", call: () => list.GET() },
  ...(["propose", "state_payer", "mark_paid", "erase"] as const).map((action) => ({
    name: `POST /api/payments ${action}`,
    call: () =>
      list.POST(
        post("http://localhost/api/payments", {
          action,
          payment_id: PAYMENT,
          holder_name: "x",
          iban: "DE89370400440532013000",
          payment: {},
        }),
      ),
  })),
  {
    name: "POST /api/payments/file (a new file)",
    call: () => file.POST(post("http://localhost/api/payments/file", { format: "sepa" })),
  },
  {
    name: "GET /api/payments/file?batch= (a file again)",
    call: () => file.GET(new NextRequest(`http://localhost/api/payments/file?batch=${BATCH}`)),
  },
];

beforeEach(() => {
  resolveAccess.mockReset();
  touched.mockReset();
});

describe("every payments route is the owner's alone", () => {
  for (const role of ["manager", "viewer"] as const) {
    for (const door of DOORS) {
      it(`${role}: ${door.name} is refused, and nothing is read or written`, async () => {
        resolveAccess.mockResolvedValue(as(role));
        const res = await door.call();
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; needs: string; role: string };
        expect(body.needs).toBe("owner");
        expect(body.role).toBe(role);
        expect(body.error).toMatch(/^Only an owner can /);
        expect(touched).not.toHaveBeenCalled();
      });
    }
  }

  it("the list's refusal is its own sentence", async () => {
    resolveAccess.mockResolvedValue(as("manager"));
    const res = await list.GET();
    expect(((await res.json()) as { error: string }).error).toBe(
      "Only an owner can see payments and their bank files.",
    );
  });

  it("no session: 401 on every door, nothing touched", async () => {
    resolveAccess.mockResolvedValue(null);
    for (const door of DOORS) {
      expect((await door.call()).status, door.name).toBe(401);
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it("the owner gets through: the list is read, with its files", async () => {
    resolveAccess.mockResolvedValue(as("owner"));
    const res = await list.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exports: unknown[]; can_prepare: boolean };
    expect(body.exports).toEqual([]);
    expect(body.can_prepare).toBe(true);
    expect(touched).toHaveBeenCalledWith("listExports");
  });

  it("a GET without a batch makes no new file: new files are POSTs", async () => {
    resolveAccess.mockResolvedValue(as("owner"));
    const res = await file.GET(new NextRequest("http://localhost/api/payments/file?format=sepa"));
    expect(res.status).toBe(405);
    expect(touched).not.toHaveBeenCalled();
  });
});
