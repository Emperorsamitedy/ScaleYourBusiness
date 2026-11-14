// The bookkeeper path for NAV Online Számla — the multi-market spec §E.4:
// "a firm can set this up across its whole client book from the Partner
// Console (§7.6), under an active mandate." Proven here against a
// recorded-shape NAV:
//
//   - each client is checked in the database (partner_may, manage_connectors)
//     before anything is stored; a client without that mandate is "not
//     found" and nothing is written for it
//   - each technical user is validated at once with queryTaxpayer, and the
//     business's registered name comes back
//   - credentials are sealed under the client's own key, never in the clear,
//     never in the answer, never in a log line
//   - one client's failure never stops the rest of the book
//   - each connection and each revocation is in the owner's audit trail as
//     the partner's own action
//   - staff can't run it; a revoked mandate stops it at the next call

import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  firmMembers,
  firms,
  mandates,
  users,
} from "../../db/schema";
import { createOwner } from "../auth/service";
import type { NavTransport } from "../connectors/nav/connector";
import { NAV_CONNECTOR } from "../connectors/nav/connector";
import type { NavSoftware } from "../connectors/nav/protocol";
import { bootstrapIntake } from "../intake/service";
import { PartnerAccessError } from "./access";
import { createFirm } from "./firm";
import { grantMandate, revokeMandate } from "./mandates";
import { NAV_BULK_MAX, bulkConnectNav, navBook, revokeNavForClient } from "./nav";

const profiles: string[] = [];
const accountIds: string[] = [];
const firmIds: string[] = [];

afterAll(async () => {
  if (accountIds.length > 0)
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  if (firmIds.length > 0) {
    await db.delete(mandates).where(inArray(mandates.firm_id, firmIds));
    await db.delete(firmMembers).where(inArray(firmMembers.firm_id, firmIds));
    await db.delete(firms).where(inArray(firms.id, firmIds));
  }
  if (profiles.length > 0)
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profiles));
  if (accountIds.length > 0) {
    await db.update(accounts).set({ owner_user_id: null }).where(inArray(accounts.id, accountIds));
    await db.delete(users).where(inArray(users.account_id, accountIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

const SOFTWARE: NavSoftware = {
  softwareId: "HU12345678-SYB0001",
  softwareName: "SYB",
  softwareOperation: "ONLINE_SERVICE",
  softwareMainVersion: "1.0",
  softwareDevName: "SYB",
  softwareDevContact: "support@example.invalid",
};
const MASTER = randomBytes(32);

/** NAV that knows a technical user by its login: the name it answers with, or a rejection. */
function nav(names: Record<string, string>): NavTransport {
  return async (url, xml) => {
    if (!url.endsWith("/queryTaxpayer")) throw new Error("only queryTaxpayer at connect");
    const login = Object.keys(names).find((l) => xml.includes(`<common:login>${l}</common:login>`));
    if (!login)
      return { status: 200, text: "<r><funcCode>ERROR</funcCode><errorCode>X</errorCode></r>" };
    return {
      status: 200,
      text: `<r><funcCode>OK</funcCode><taxpayerValidity>true</taxpayerValidity><taxpayerData><taxpayerName>${names[login]}</taxpayerName></taxpayerData></r>`,
    };
  };
}
const deps = (t: NavTransport) => ({ software: SOFTWARE, transport: t, master: MASTER });

const creds = (n: string) => ({
  login: `tech-${n}`,
  password: `pw-${n}-${randomUUID()}`,
  signatureKey: `sig-${n}-${randomUUID()}`,
  taxNumber: "12345678-2-42",
});

async function client(email = `owner-${randomUUID()}@example.test`) {
  const s = await bootstrapIntake();
  profiles.push(s.profile_id);
  accountIds.push(s.account_id);
  const owner = await createOwner(s.account_id, email);
  return { ...s, owner };
}

async function firmWith(role: "manager" | "staff" | null = null) {
  const p = await client(`partner-${randomUUID()}@example.test`);
  const firm = await createFirm({
    userId: p.owner.id,
    name: "Kovács & Társa",
    country: "HU",
    type: "bookkeeping",
  });
  firmIds.push(firm.id);
  if (!role) return { user: p.owner, firm };
  const m = await client(`member-${randomUUID()}@example.test`);
  await db.insert(firmMembers).values({ firm_id: firm.id, user_id: m.owner.id, role });
  return { user: m.owner, firm };
}

async function mandated(firmId: string, scopes: string[]) {
  const c = await client();
  await grantMandate({
    ownerUserId: c.owner.id,
    profileId: c.profile_id,
    firmId,
    scopes,
    evidenceRef: "EL-2026-11",
  });
  return c;
}

async function navRow(accountId: string) {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.account_id, accountId), eq(connections.provider, NAV_CONNECTOR)));
  return row ?? null;
}

describe("§E.4 bookkeeper path — NAV across the client book, under a mandate", () => {
  it("connects every client it may, validates each at once, and names each business back", async () => {
    const { user, firm } = await firmWith("manager");
    const a = await mandated(firm.id, ["read_diagnosis", "manage_connectors"]);
    const b = await mandated(firm.id, ["manage_connectors"]);
    const ca = creds("a");
    const cb = creds("b");
    const r = await bulkConnectNav({
      userId: user.id,
      rows: [
        { client: a.profile_id, ...ca },
        { client: b.profile_id, ...cb },
      ],
      deps: deps(nav({ "tech-a": "Rózsa Kávézó Kft.", "tech-b": "Kis Pék Bt." })),
    });
    expect(r.connected).toBe(2);
    expect(r.results).toEqual([
      { client: a.profile_id, outcome: "connected", taxpayer_name: "Rózsa Kávézó Kft." },
      { client: b.profile_id, outcome: "connected", taxpayer_name: "Kis Pék Bt." },
    ]);
    // Sealed under each client's own key: nothing readable is stored.
    const rowA = await navRow(a.account_id);
    expect(rowA).toMatchObject({ status: "connected", purpose: "measure" });
    expect(rowA?.encrypted_secret).not.toContain(ca.password);
    expect(rowA?.encrypted_secret).not.toContain(ca.signatureKey);
    // The owner's audit trail names the partner.
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, a.profile_id), eq(decisionLog.kind, "partner_action")));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "partner", user_id: user.id });
    expect(log[0]!.ref_id).toBe(`nav_connect:${firm.id}:${rowA!.id}`);
    // The book shows both as connected.
    const book = await navBook(user.id);
    expect(book.find((x) => x.profile_id === a.profile_id)).toMatchObject({ nav: "connected" });
  });

  it("a client without a manage_connectors mandate is not found, and nothing is stored for it", async () => {
    const { user, firm } = await firmWith();
    const readOnly = await mandated(firm.id, ["read_diagnosis"]);
    const stranger = await client();
    const fine = await mandated(firm.id, ["manage_connectors"]);
    const r = await bulkConnectNav({
      userId: user.id,
      rows: [
        { client: readOnly.profile_id, ...creds("r") },
        { client: stranger.profile_id, ...creds("s") },
        { client: fine.profile_id, ...creds("f") },
      ],
      deps: deps(nav({ "tech-r": "R", "tech-s": "S", "tech-f": "F" })),
    });
    expect(r.results.map((x) => x.outcome)).toEqual(["not_found", "not_found", "connected"]);
    expect(await navRow(readOnly.account_id)).toBeNull();
    expect(await navRow(stranger.account_id)).toBeNull();
    // The book lists only the clients it may help with connections.
    const ids = (await navBook(user.id)).map((x) => x.profile_id);
    expect(ids).toContain(fine.profile_id);
    expect(ids).not.toContain(readOnly.profile_id);
  });

  it("a rejected technical user, a client already connected, or a blank row never stops the rest", async () => {
    const { user, firm } = await firmWith();
    const bad = await mandated(firm.id, ["manage_connectors"]);
    const twice = await mandated(firm.id, ["manage_connectors"]);
    const blank = await mandated(firm.id, ["manage_connectors"]);
    const good = await mandated(firm.id, ["manage_connectors"]);
    const t = nav({ "tech-t": "T", "tech-g": "G" });
    await bulkConnectNav({
      userId: user.id,
      rows: [{ client: twice.profile_id, ...creds("t") }],
      deps: deps(t),
    });
    const r = await bulkConnectNav({
      userId: user.id,
      rows: [
        { client: bad.profile_id, ...creds("wrong") },
        { client: twice.profile_id, ...creds("t") },
        { client: blank.profile_id, login: "", password: "", signatureKey: "", taxNumber: "" },
        { client: good.profile_id, ...creds("g") },
      ],
      deps: deps(t),
    });
    expect(r.results.map((x) => x.outcome)).toEqual([
      "rejected",
      "already_connected",
      "skipped",
      "connected",
    ]);
    expect(r).toMatchObject({ connected: 1, rejected: 1, skipped: 1 });
    expect(await navRow(bad.account_id)).toBeNull();
  });

  it("never puts a credential in the answer or in a log line", async () => {
    const { user, firm } = await firmWith();
    const a = await mandated(firm.id, ["manage_connectors"]);
    const b = await mandated(firm.id, ["manage_connectors"]);
    const ca = creds("la");
    const cb = creds("lb");
    const lines: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    let answer: unknown;
    try {
      answer = await bulkConnectNav({
        userId: user.id,
        rows: [
          { client: a.profile_id, ...ca },
          { client: b.profile_id, ...cb },
        ],
        // b's NAV call breaks outright: NAV is unreachable for it, and the input stays unsaid.
        deps: deps(async (url, xml) => {
          if (xml.includes("tech-lb")) throw new Error(`boom ${xml}`);
          return nav({ "tech-la": "LA" })(url, xml);
        }),
      });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const text = JSON.stringify(answer) + lines.join("\n");
    for (const secret of [ca.password, ca.signatureKey, cb.password, cb.signatureKey, "tech-l"]) {
      expect(text).not.toContain(secret);
    }
    expect(answer).toMatchObject({ connected: 1, rejected: 1 });
  });

  it("staff can't run it, a revoked mandate stops it at once, and a partner can revoke under the mandate", async () => {
    const { firm, user } = await firmWith();
    const staff = await firmWith("staff");
    await expect(
      bulkConnectNav({ userId: staff.user.id, rows: [], deps: deps(nav({})) }),
    ).rejects.toBeInstanceOf(PartnerAccessError);

    const c = await mandated(firm.id, ["manage_connectors"]);
    const t = nav({ "tech-v": "V" });
    await bulkConnectNav({
      userId: user.id,
      rows: [{ client: c.profile_id, ...creds("v") }],
      deps: deps(t),
    });
    // One tap from the console: the stored credentials are gone now.
    const r = await revokeNavForClient({ userId: user.id, profileId: c.profile_id });
    expect(r.revoked).toBe(true);
    const row = await navRow(c.account_id);
    expect(row).toMatchObject({ status: "disconnected", encrypted_secret: null });
    const log = await db
      .select({ ref: decisionLog.ref_id })
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, c.profile_id), eq(decisionLog.kind, "partner_action")));
    expect(log.map((l) => l.ref.split(":")[0]).sort()).toEqual(["nav_connect", "nav_revoke"]);

    // The owner withdraws the mandate: the next call is refused.
    const [m] = await db.select().from(mandates).where(eq(mandates.profile_id, c.profile_id));
    await revokeMandate({ ownerUserId: c.owner.id, profileId: c.profile_id, mandateId: m!.id });
    const after = await bulkConnectNav({
      userId: user.id,
      rows: [{ client: c.profile_id, ...creds("v") }],
      deps: deps(t),
    });
    expect(after.results[0]!.outcome).toBe("not_found");
    await expect(
      revokeNavForClient({ userId: user.id, profileId: c.profile_id }),
    ).rejects.toBeInstanceOf(PartnerAccessError);
  });

  it("refuses a batch larger than a book", async () => {
    const { user } = await firmWith();
    const rows = Array.from({ length: NAV_BULK_MAX + 1 }, () => ({
      client: randomUUID(),
      ...creds("x"),
    }));
    await expect(bulkConnectNav({ userId: user.id, rows, deps: deps(nav({})) })).rejects.toThrow();
  });
});
