// NAV for one business — the multi-market spec §E.4–§E.6, against a
// recorded-shape NAV: connect validates at once and names the business back;
// sync stores both sides; a rejected technical user degrades with a
// Hungarian reconnect message and never blanks anything; revocation wipes
// the credentials at once.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  connections,
  intakeEvents,
  metricObservations,
} from "../../../db/schema";
import { bootstrapIntake } from "../../intake/service";
import type { NavTransport } from "./connector";
import { NAV_CONNECTOR } from "./connector";
import type { NavCredentials, NavSoftware } from "./protocol";
import {
  NAV_SERVICE_WORDS,
  NavServiceError,
  connectNav,
  navSoftwareFromEnv,
  revokeNav,
  syncNav,
} from "./service";

const created: { account_id: string; profile_id: string }[] = [];
const MASTER = randomBytes(32);
const SOFTWARE: NavSoftware = {
  softwareId: "HU12345678-SYB0001",
  softwareName: "SYB",
  softwareOperation: "ONLINE_SERVICE",
  softwareMainVersion: "1.0",
  softwareDevName: "SYB",
  softwareDevContact: "support@example.invalid",
};
const CREDS: NavCredentials = {
  login: "tech-login-1",
  password: "secret-password-1",
  signatureKey: "signature-key-1",
  taxNumber: "12345678-2-42",
};
const NOW = new Date("2026-11-10T12:00:00Z");

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (rows.length)
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        rows.map((r) => r.id),
      ),
    );
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  for (const s of created) {
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

const ok = (body: string) => `<r><funcCode>OK</funcCode>${body}</r>`;
const digest = (day: string, net: string) =>
  `<invoiceDigest><invoiceNumber>N-${day}-${net}</invoiceNumber><invoiceOperation>CREATE</invoiceOperation><invoiceCategory>NORMAL</invoiceCategory><invoiceIssueDate>${day}</invoiceIssueDate><supplierTaxNumber>12345678</supplierTaxNumber><supplierName>X</supplierName><currency>HUF</currency><invoiceNetAmount>${net}</invoiceNetAmount><invoiceVatAmount>0</invoiceVatAmount><insDate>2026-11-02T10:00:00Z</insDate></invoiceDigest>`;

function nav(opts: { reject?: boolean } = {}): NavTransport {
  return async (url, xml) => {
    if (opts.reject)
      return { status: 200, text: `<r><funcCode>ERROR</funcCode><errorCode>X</errorCode></r>` };
    if (url.endsWith("/queryTaxpayer")) {
      return {
        status: 200,
        text: ok(
          "<taxpayerValidity>true</taxpayerValidity><taxpayerData><taxpayerName>Rózsa Kávézó Kft.</taxpayerName></taxpayerData>",
        ),
      };
    }
    const outbound = xml.includes("OUTBOUND");
    const nov = xml.includes("<dateFrom>2026-11-01</dateFrom>");
    const items = nov
      ? outbound
        ? digest("2026-11-02", "100000")
        : digest("2026-11-03", "40000")
      : "";
    return {
      status: 200,
      text: ok(`<currentPage>1</currentPage><availablePage>1</availablePage>${items}`),
    };
  };
}

async function account() {
  const s = await bootstrapIntake();
  created.push(s);
  return s.account_id;
}

const deps = (t: NavTransport) => ({
  software: SOFTWARE,
  transport: t,
  master: MASTER,
  now: () => NOW,
});

describe("§E.4 — connect validates at once and names the business back", () => {
  it("stores the credentials sealed, never in the clear", async () => {
    const accountId = await account();
    const r = await connectNav(accountId, CREDS, deps(nav()));
    expect(r.taxpayer_name).toBe("Rózsa Kávézó Kft.");
    const [row] = await db.select().from(connections).where(eq(connections.id, r.connection_id));
    expect(row).toMatchObject({ provider: NAV_CONNECTOR, purpose: "measure", status: "connected" });
    for (const secret of [CREDS.password, CREDS.signatureKey, CREDS.login]) {
      expect(row!.encrypted_secret).not.toContain(secret);
    }
    await expect(connectNav(accountId, CREDS, deps(nav()))).rejects.toThrow(/already connected/);
  });

  it("a technical user NAV rejects is never stored", async () => {
    const accountId = await account();
    await expect(connectNav(accountId, CREDS, deps(nav({ reject: true })))).rejects.toBeInstanceOf(
      NavServiceError,
    );
    const rows = await db.select().from(connections).where(eq(connections.account_id, accountId));
    expect(rows).toHaveLength(0);
  });

  it("can't reach NAV at all until ScaleX's software ID is configured", async () => {
    expect(navSoftwareFromEnv({})).toBeNull();
    const accountId = await account();
    await expect(connectNav(accountId, CREDS, { ...deps(nav()), software: null })).rejects.toThrow(
      NAV_SERVICE_WORDS.notConfigured.en,
    );
    expect(() => navSoftwareFromEnv({ NAV_SOFTWARE_ID: "too-short" })).toThrow(/18 characters/);
  });
});

describe("§E.3 / §E.6 — sync, and degrading without blanking", () => {
  it("stores issuer-side revenue and buyer-side cost as observations", async () => {
    const accountId = await account();
    const { connection_id } = await connectNav(accountId, CREDS, deps(nav()));
    expect(await syncNav(connection_id, deps(nav()))).toEqual({ observations: 2 });
    const obs = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, connection_id));
    expect(
      obs.map((o) => [o.metric_key, o.period_date, Number(o.value_minor), o.currency]).sort(),
    ).toEqual([
      ["purchases.daily", "2026-11-03", 4_000_000, "HUF"],
      ["revenue.daily", "2026-11-02", 10_000_000, "HUF"],
    ]);
  });

  it("a rejected technical user marks the connection failed, in Hungarian — what was read stays", async () => {
    const accountId = await account();
    const { connection_id } = await connectNav(accountId, CREDS, deps(nav()));
    await syncNav(connection_id, deps(nav()));
    const r = await syncNav(connection_id, deps(nav({ reject: true })));
    expect(r).toEqual({ failed: true, message_hu: NAV_SERVICE_WORDS.degraded.hu });
    const [row] = await db.select().from(connections).where(eq(connections.id, connection_id));
    expect(row).toMatchObject({ status: "failed", last_error: NAV_SERVICE_WORDS.degraded.hu });
    expect(row!.last_error).not.toMatch(/\b[45]\d\d\b|ERROR|funcCode/);
    const kept = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, connection_id));
    expect(kept).toHaveLength(2);
  });
});

describe("§E.5 — one-tap revocation", () => {
  it("deletes the stored credentials at once and tells the owner, in Hungarian, to delete the technical user", async () => {
    const accountId = await account();
    const { connection_id } = await connectNav(accountId, CREDS, deps(nav()));
    const started = Date.now();
    const r = await revokeNav(accountId);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r).toMatchObject({
      revoked: true,
      message_hu: expect.stringMatching(/Online Számlában is/),
    });
    const [row] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.id, connection_id)));
    expect(row).toMatchObject({ status: "disconnected", encrypted_secret: null });
  });
});
