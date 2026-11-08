// P6-09 at the door: /api/stock/po/:id?format=pdf. The same gate as the
// page — a session for the business, and only that business's own order —
// and then a real PDF as a file named after the order. The session lookup
// and the order read are stubbed (the order read's own business filter is
// held against the database in lib/purchasing/purchase-order.test.ts); the
// PDF is the real renderer's, read back as text.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Access } from "../../../../../lib/auth/access";
import type { PoDocStatus, PurchaseOrder } from "../../../../../lib/purchasing/po";
import { poLine, poNumber, poTotals } from "../../../../../lib/purchasing/po";
import { pdfText } from "../../../../../lib/purchasing/pdf-text.test-util";

const OWN = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";

const resolveAccess = vi.fn<() => Promise<Access | null>>(async () => null);
vi.mock("../../../../../lib/auth/access", () => ({ resolveAccess }));

const lines = [
  poLine(
    {
      key: "c:1",
      name: "Blue Mug",
      suggested: 50,
      arithmetic: "x",
      unit_cost: { amount_minor: 980, currency: "EUR" },
      cost_basis: "measured",
    },
    null,
  ),
];
const PO: PurchaseOrder = {
  number: poNumber(1),
  business: "Fernhill Ceramics",
  supplier: { id: "s", name: "Midland Clay", email: "orders@midland.test", email_field: "f" },
  lines,
  ...poTotals(lines),
  delivery_address: "Unit 4, Mill Lane",
  delivery_address_field: null,
  note: null,
  prepared_on: "2026-11-08",
};

const poForDocument = vi.fn(
  async (
    profileId: string,
    proposalId: string,
  ): Promise<{ po: PurchaseOrder; status: PoDocStatus; locale: "en" | "zh-Hans" } | null> =>
    profileId === OWN && proposalId === ORDER
      ? { po: PO, status: { kind: "approved" }, locale: "en" }
      : null,
);
vi.mock("../../../../../lib/purchasing/send", () => ({
  PO_WORDS: "emails.purchaseOrder",
  poForDocument,
}));

const { GET } = await import("./route");

const access = (profile_id: string) =>
  ({ account_id: "acc", profile_id, owned: true, session: null }) as unknown as Access;

const get = (id: string, query = "?format=pdf") =>
  GET(new NextRequest(`http://localhost/api/stock/po/${id}${query}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  resolveAccess.mockReset();
  resolveAccess.mockResolvedValue(null);
});

describe("/api/stock/po/:id?format=pdf — the owner's own order only", () => {
  it("refuses without a session, and reads no order", async () => {
    poForDocument.mockClear();
    const res = await get(ORDER);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toContain("pdf");
    expect(poForDocument).not.toHaveBeenCalled();
  });

  it("refuses another business: no such order, no PDF", async () => {
    resolveAccess.mockResolvedValue(access("33333333-3333-4333-8333-333333333333"));
    const res = await get(ORDER);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such order" });
  });

  it("refuses an id that isn't one", async () => {
    resolveAccess.mockResolvedValue(access(OWN));
    expect((await get("not-an-id")).status).toBe(404);
  });

  it("gives the owner the PDF as a file named after the order", async () => {
    resolveAccess.mockResolvedValue(access(OWN));
    const res = await get(ORDER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="PO-0001.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    const text = (await pdfText(bytes)).runs.join("\n");
    expect(text).toContain("Purchase order PO-0001");
    expect(text).toContain("Blue Mug");
    expect(text).toContain("Expected total: €490.00");
    expect(text).toContain("Approved: not sent yet");
  });

  it("a Chinese business's PDF is in English; its page stays in Chinese", async () => {
    resolveAccess.mockResolvedValue(access(OWN));
    poForDocument.mockResolvedValueOnce({ po: PO, status: { kind: "draft" }, locale: "zh-Hans" });
    const text = (await pdfText(new Uint8Array(await (await get(ORDER)).arrayBuffer()))).runs.join(
      "\n",
    );
    expect(text).toContain("Purchase order PO-0001");
    poForDocument.mockResolvedValueOnce({ po: PO, status: { kind: "draft" }, locale: "zh-Hans" });
    const page = await (await get(ORDER, "")).text();
    expect(page).toContain('lang="zh-Hans"');
  });

  it("without format=pdf, the page is unchanged: HTML", async () => {
    resolveAccess.mockResolvedValue(access(OWN));
    const res = await get(ORDER, "?download=1");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="PO-0001.html"');
  });
});
