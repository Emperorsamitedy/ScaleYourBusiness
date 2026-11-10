// The NAV Online Számla connector — the multi-market spec Part E, under the
// §11.1 contract (lib/connectors/contract.ts).
//
// Read-only: push() is absent — not stubbed, not guarded. It reads the
// taxpayer's own invoice digests in both directions:
//   OUTBOUND (issued by the business)  → revenue.daily   (net of VAT)
//   INBOUND  (received by the business) → purchases.daily (net of VAT)
// summed per issue day and currency, a STORNO's negative amounts netting
// the invoice it cancels. Both reach the normalised schema graded B (§E.3),
// told apart as revenue and cost; the diagnosis never learns they came from
// NAV rather than Stripe.
//
// No live call happens anywhere until NAV_SOFTWARE_ID is configured, and
// that waits on counsel (specs/nav-online-szamla-v3.md, "Software block").
// Errors are fixed sentences in Hungarian and English: no NAV message, no
// request, nothing that could carry a credential reaches a log or the owner.

import type { Connector, ConnectorHealth, NormalisedEvent } from "../contract";
import { normalise } from "../contract";
import type { Observation } from "../provider";
import type { Direction, DigestItem, NavCredentials, NavSoftware } from "./protocol";
import {
  NAV_ENDPOINTS,
  NAV_OPERATIONS,
  buildRequest,
  newRequestId,
  readDigest,
  readResult,
  readTaxpayer,
} from "./protocol";

export const NAV_CONNECTOR = "nav_online_szamla";
export const NAV_LABEL = "NAV Online Számla";

/** A month at a time (NAV's maximum range is unverified), and a hard page cap per pull. */
export const NAV_MAX_PAGES_PER_PULL = 200;

export type NavTransport = (url: string, xml: string) => Promise<{ status: number; text: string }>;

export class NavConnectorError extends Error {
  readonly hu: string;
  constructor(en: string, hu: string) {
    super(en);
    this.name = "NavConnectorError";
    this.hu = hu;
  }
}

export const NAV_WORDS = {
  rejected: {
    en: "NAV didn't accept the technical user — check it in Online Számla, then reconnect.",
    hu: "A NAV nem fogadta el a technikai felhasználót — ellenőrizze az Online Számlában, majd csatlakoztassa újra.",
  },
  unreachable: {
    en: "NAV couldn't be reached — SYB will try again later.",
    hu: "A NAV most nem érhető el — a SYB később újra próbálja.",
  },
  invalidTaxpayer: {
    en: "NAV doesn't know this tax number as a valid taxpayer.",
    hu: "A NAV ezt az adószámot nem ismeri érvényes adózóként.",
  },
} as const;

function fail(w: { en: string; hu: string }): never {
  throw new NavConnectorError(w.en, w.hu);
}

export interface NavConnectorOptions {
  /** Opens the stored credentials for one call (lib/connectors/nav/vault.ts). */
  withCredentials: <T>(work: (c: NavCredentials) => Promise<T>) => Promise<T>;
  software: NavSoftware;
  environment: keyof typeof NAV_ENDPOINTS;
  transport: NavTransport;
  now?: () => Date;
  random?: () => string;
  /** The stored connection, for health. */
  connection?: { status: string; last_sync_at: string | null; failure_count: number };
}

function months(since: string, until: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let y = Number(since.slice(0, 4));
  let m = Number(since.slice(5, 7));
  while (true) {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    if (first > until) break;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({ from: first < since ? since : first, to: last > until ? until : last });
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Pure: digest items → one observation per day, currency and side. */
export function digestObservations(
  items: readonly DigestItem[],
  direction: Direction,
  observedAt: string,
): Observation[] {
  const metric = direction === "OUTBOUND" ? "revenue.daily" : "purchases.daily";
  const sums = new Map<string, { day: string; currency: string; minor: number }>();
  for (const it of items) {
    const key = `${it.issueDate}|${it.currency}`;
    const held = sums.get(key) ?? { day: it.issueDate, currency: it.currency, minor: 0 };
    held.minor += it.net_minor;
    sums.set(key, held);
  }
  return [...sums.values()].map((s) => ({
    metric_key: metric,
    period_date: s.day,
    dimensions: { currency: s.currency },
    value_minor: s.minor,
    observed_at: observedAt,
  }));
}

/** The §11.1 contract, plus what onboarding shows back: the business's own registered name. */
export type NavConnector = Connector & {
  /** Set by a successful authorize(): NAV's record of the taxpayer. */
  taxpayer(): { name: string | null; incorporation: string | null } | null;
};

export function navConnector(o: NavConnectorOptions): NavConnector {
  const now = o.now ?? (() => new Date());
  const random = o.random ?? (() => crypto.randomUUID());
  const url = NAV_ENDPOINTS[o.environment];
  let latency: number | null = null;
  let lastSuccess: string | null = o.connection?.last_sync_at ?? null;
  let lastFailed = false;
  let known: { name: string | null; incorporation: string | null } | null = null;

  async function call(req: Parameters<typeof buildRequest>[0], c: NavCredentials): Promise<string> {
    const timestamp = now().toISOString();
    const xml = buildRequest(req, c, o.software, { requestId: newRequestId(random), timestamp });
    const started = Date.now();
    let res: { status: number; text: string };
    try {
      res = await o.transport(`${url}/${req.op}`, xml);
    } catch {
      lastFailed = true;
      fail(NAV_WORDS.unreachable);
    } finally {
      latency = Date.now() - started;
    }
    const result = readResult(res.text);
    if (!result.ok || res.status >= 400) {
      lastFailed = true;
      fail(res.status >= 500 ? NAV_WORDS.unreachable : NAV_WORDS.rejected);
    }
    lastFailed = false;
    lastSuccess = now().toISOString();
    return res.text;
  }

  return {
    id: NAV_CONNECTOR,
    label: NAV_LABEL,

    async authorize() {
      try {
        return await o.withCredentials(async (c) => {
          const t = readTaxpayer(await call({ op: "queryTaxpayer", taxNumber: c.taxNumber }, c));
          if (!t.valid) fail(NAV_WORDS.invalidTaxpayer);
          known = { name: t.name, incorporation: t.incorporation };
          return { ok: true as const, scopes_held: [...NAV_OPERATIONS] };
        });
      } catch (error) {
        if (error instanceof NavConnectorError) return { ok: false, reason: error.message };
        return { ok: false, reason: NAV_WORDS.rejected.en };
      }
    },

    async health(): Promise<ConnectorHealth> {
      const c = o.connection;
      const status =
        c?.status === "disconnected"
          ? "not_connected"
          : c?.status === "failed"
            ? "failed"
            : lastFailed || (c?.failure_count ?? 0) > 0
              ? "degraded"
              : "healthy";
      return {
        status,
        last_success_at: lastSuccess,
        latency_ms: latency,
        scopes_held: [...NAV_OPERATIONS],
        scopes_needed: ["queryTaxpayer", "queryInvoiceDigest"],
      };
    },

    async pull(since): Promise<NormalisedEvent[]> {
      const until = now().toISOString().slice(0, 10);
      const observedAt = now().toISOString();
      return o.withCredentials(async (c) => {
        const events: NormalisedEvent[] = [];
        let pages = 0;
        for (const direction of ["OUTBOUND", "INBOUND"] as const) {
          for (const range of months(since, until)) {
            const items: DigestItem[] = [];
            for (let page = 1; ; page++) {
              if (++pages > NAV_MAX_PAGES_PER_PULL) fail(NAV_WORDS.unreachable);
              const d = readDigest(
                await call(
                  { op: "queryInvoiceDigest", page, direction, from: range.from, to: range.to },
                  c,
                ),
              );
              items.push(...d.items);
              if (d.availablePage <= page) break;
            }
            for (const obs of digestObservations(items, direction, observedAt)) {
              events.push(normalise(NAV_CONNECTOR, NAV_LABEL, obs));
            }
          }
        }
        return events;
      });
    },

    taxpayer() {
      return known;
    },

    capabilities() {
      return [
        { kind: "read", metric: "revenue.daily" },
        { kind: "read", metric: "purchases.daily" },
      ];
    },

    cost_model() {
      return { per_call: { amount_minor: 0, currency: "HUF" }, quota: null, reset_at: null };
    },
  };
}
