// /api/ops/compliance-matrix — §9.5: "the country matrix is configuration,
// loadable without a deploy, and every change is audit-logged".

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { countryChanges, countryRule, removeCountryRule } from "../../../../lib/compliance/matrix";
import { POST } from "./route";

const KEY = "ops-test-key";
const COUNTRY = "QP"; // ISO user-assigned: never a real country
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.OPS_KEY;
  process.env.OPS_KEY = KEY;
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPS_KEY;
  else process.env.OPS_KEY = savedKey;
  if (await countryRule(COUNTRY)) {
    await removeCountryRule({ country: COUNTRY, actor: "test", reason: "cleanup" });
  }
});

function post(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(
    new NextRequest("http://localhost/api/ops/compliance-matrix", { method: "POST", body: form }),
  );
}

const ROW = {
  country: COUNTRY.toLowerCase(),
  recording_regime: "all_party",
  criminal_penalty: "on",
  outbound_consent_required: "on",
  blocked: "on",
  outbound_blocked: "on",
  actor: "Anna (ops)",
  reason: "adding the row",
};

/** The row with the phone-answering box unticked — the form sends nothing for it. */
function unblockedRow(): Record<string, string> {
  return Object.fromEntries(Object.entries(ROW).filter(([k]) => k !== "blocked"));
}

describe("POST /api/ops/compliance-matrix", () => {
  it("a wrong key answers like a missing route and changes nothing", async () => {
    const res = await post({ ...ROW, key: "wrong" });
    expect(res.status).toBe(404);
    expect(await countryRule(COUNTRY)).toBeNull();
  });

  it("saves a row and logs who and why", async () => {
    const res = await post({ ...ROW, key: KEY });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/compliance_matrix=saved/);
    expect(await countryRule(COUNTRY)).toMatchObject({
      blocked: true,
      recording_regime: "all_party",
    });
    const [change] = await countryChanges(COUNTRY);
    expect(change).toMatchObject({ actor: "Anna (ops)", reason: "adding the row", op: "INSERT" });
  });

  it("refuses an unblock without counsel's sign-off, and says so", async () => {
    const res = await post({ ...unblockedRow(), key: KEY, reason: "try to unblock" });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toMatch(/sign-off/);
    expect((await countryRule(COUNTRY))?.blocked).toBe(true);
  });

  it("unblocks with a dated sign-off — no deploy", async () => {
    await post({
      ...unblockedRow(),
      key: KEY,
      legal_signoff_date: "2026-11-09",
      legal_signoff_reference: "Counsel letter 2026/14",
      reason: "counsel signed off inbound",
    });
    expect(await countryRule(COUNTRY)).toMatchObject({
      blocked: false,
      outbound_blocked: true,
      legal_signoff_reference: "Counsel letter 2026/14",
    });
  });

  it("refuses a change with no name on it", async () => {
    const res = await post({ ...ROW, key: KEY, actor: " " });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toMatch(/who/);
  });
});
