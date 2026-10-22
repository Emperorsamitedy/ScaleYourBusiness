"use client";

// The connections screen — P2-12, extended for stores (Session C) and for
// analytics and ads (Session D); the owner's Connections design
// (2026-10-17): a patch panel of every source and a separate sheet for
// write access.
//
// What an owner sees about each data source: what it reads (the scope
// registry's own words), whether it is on, that it can never write, and
// when it last read. Settings opens the rest — the permissions it was
// granted (verbatim from the database), whether those were verified or
// only tested, how far its history reaches, the last error, matching,
// sync and disconnect. Connect opens the setup steps and the credential
// form, which render the scope registry (SCOPE_GUIDE), so the screen
// cannot promise a permission the code doesn't declare. Below it, write
// access (P3-20h) keeps visibly apart: its own sheet and its own consent.

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { ExecView } from "./ExecutionSection";
import { ExecutionSection } from "./ExecutionSection";
import type { EmailView } from "./EmailCampaignSection";
import { EmailCampaignSection } from "./EmailCampaignSection";
import { BookingsImportSection } from "./BookingsImportSection";
import { gives, headline, lastRead, parseTs } from "./patch";
import "../../app/connections.css";

type Verification = "reported" | "probed";
type Matching = "product" | "channel" | null;

interface GuideEntry {
  scope: string;
  grant: string;
  why: string;
}

interface CredentialField {
  name: string;
  label: string;
  placeholder: string;
  secret: boolean;
  multiline?: boolean;
}

interface ProviderOption {
  id: string;
  label: string;
  scope_verification: Verification;
  guide: GuideEntry[];
  credential_fields: CredentialField[];
  matching: Matching;
}

interface Connection {
  id: string;
  provider: string;
  label: string;
  status: "connected" | "paused" | "failed" | "disconnected";
  scope_verification: Verification;
  granted_scopes: string[];
  cursor: string | null;
  last_sync_at: string | null;
  failure_count: number;
  last_error: string | null;
  created_at: string;
  disconnected_at: string | null;
  history_days: number;
  matching: Matching;
}

interface View {
  connections: Connection[];
  providers: ProviderOption[];
}

interface ExternalItem {
  ref: string;
  title: string;
  status: string | null;
}

interface EntityMappingRow {
  entity_id: string;
  name: string;
  mapped: { ref: string; label_raw: string } | null;
  no_match: boolean;
  suggestion: { ref: string; title: string; score: number } | null;
}

interface MappingView {
  kind: "product" | "channel";
  entity_noun: string;
  item_noun: string;
  entities: EntityMappingRow[];
  items: ExternalItem[];
  unmapped_items: ExternalItem[];
}

type Payload = Record<string, unknown> | null;

const DAY_MS = 86_400_000;
const NONE = "__none__";
const KICKER = "Your business · Connections";
const ASIDE = "Reading is separate from writing — always";

function historyLine(c: Connection): string {
  const days = c.history_days;
  if (c.cursor === null) {
    return c.status === "connected"
      ? `Not synced yet. The first sync reads the last ${days} days.`
      : "Never synced.";
  }
  const through = Date.parse(`${c.cursor}T00:00:00Z`);
  const windowStart = Date.now() - days * DAY_MS;
  const pct = Math.max(
    0,
    Math.min(100, Math.round(((through - windowStart) / (days * DAY_MS)) * 100)),
  );
  return pct >= 99
    ? `Up to date through ${c.cursor}, covering the last ${days} days.`
    : `Read through ${c.cursor}, ${pct}% of the last ${days} days.`;
}

function when(iso: string | null): string {
  if (iso === null) return "never";
  return new Date(parseTs(iso)).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function send(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
): Promise<{ ok: boolean; payload: Payload }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as Payload;
  return { ok: res.ok, payload };
}

const errorText = (payload: Payload, fallback: string): string =>
  typeof payload?.error === "string" ? payload.error : fallback;

function checkedLine(c: Connection): string {
  if (c.scope_verification === "reported") {
    return `${c.label} reported exactly these permissions, and I checked them: nothing here can change anything on your side.`;
  }
  return `These reads were tested and work. ${c.label} can't tell any app what else the key allows.`;
}

/* ── matching (P2-15, P2-18) ── */

function MappingPanel({ connection }: { connection: Connection }) {
  const [view, setView] = useState<MappingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/connections/mapping?id=${encodeURIComponent(connection.id)}`);
      const payload = (await res.json().catch(() => null)) as Payload;
      if (!res.ok) {
        setError(errorText(payload, `Couldn't read ${connection.label}.`));
        return;
      }
      setView(payload as unknown as MappingView);
    } catch {
      setError("I couldn't reach the server. Try again.");
    }
  }, [connection.id, connection.label]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async (entity: EntityMappingRow) => {
    const choice = choices[entity.entity_id] ?? entity.suggestion?.ref ?? "";
    if (choice === "") return;
    setBusy(entity.entity_id);
    setError(null);
    try {
      const { ok, payload } = await send("/api/connections/mapping", "PUT", {
        id: connection.id,
        entity_id: entity.entity_id,
        ref: choice === NONE ? null : choice,
      });
      if (!ok) {
        setError(errorText(payload, "That match wasn't saved."));
        return;
      }
      setView(payload as unknown as MappingView);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (error !== null && view === null) return <p className="cn-error">{error}</p>;
  if (view === null) return <p className="cn-note">Reading {connection.label}…</p>;
  if (view.entities.length === 0) {
    return (
      <p className="cn-note">
        There are no {view.entity_noun}s in your profile to match yet. Add them in the interview
        first.
      </p>
    );
  }

  const unmatchedCount = view.unmapped_items.length;
  return (
    <div className="cn-mapping">
      <p className="cn-note">
        {view.kind === "product"
          ? `Match each thing you sell to its ${connection.label} product. Sales of a matched product become that offer's measured units a month.`
          : `Match each of your sales channels to the ${connection.label} traffic channel it corresponds to. Visits from a matched channel become that channel's measured monthly visits.`}{" "}
        I suggest matches; nothing counts until you confirm it.
      </p>
      <ul className="cn-map-list">
        {view.entities.map((entity) => {
          const selected = choices[entity.entity_id] ?? entity.suggestion?.ref ?? "";
          return (
            <li key={entity.entity_id} className="cn-map-row">
              <span className="cn-map-offer">{entity.name}</span>
              {entity.mapped !== null ? (
                <span className="cn-map-state">
                  matched to <strong>{entity.mapped.label_raw}</strong>
                </span>
              ) : entity.no_match ? (
                <span className="cn-map-state">no matching {view.item_noun}</span>
              ) : (
                <span className="cn-map-state">not matched yet</span>
              )}
              <span className="cn-map-pick">
                <select
                  className="cn-input"
                  value={selected}
                  aria-label={`${connection.label} ${view.item_noun} for ${entity.name}`}
                  onChange={(e) =>
                    setChoices((prev) => ({ ...prev, [entity.entity_id]: e.target.value }))
                  }
                  disabled={busy !== null}
                >
                  <option value="">choose a {view.item_noun}…</option>
                  {entity.suggestion !== null && (
                    <option value={entity.suggestion.ref}>
                      {entity.suggestion.title} (suggested)
                    </option>
                  )}
                  {view.items
                    .filter((i) => i.ref !== entity.suggestion?.ref)
                    .map((i) => (
                      <option key={i.ref} value={i.ref}>
                        {i.title}
                      </option>
                    ))}
                  <option value={NONE}>None of these</option>
                </select>
                <button
                  className="ghost"
                  disabled={busy !== null || selected === ""}
                  onClick={() => void confirm(entity)}
                >
                  {busy === entity.entity_id ? "saving…" : "Confirm"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {error !== null && <p className="cn-error">{error}</p>}
      {unmatchedCount > 0 && (
        <p className="cn-note">
          {unmatchedCount} {connection.label} {view.item_noun}
          {unmatchedCount === 1 ? " isn't" : "s aren't"} matched to anything in your profile.
          That&rsquo;s a gap, and I won&rsquo;t guess what{" "}
          {unmatchedCount === 1 ? "it is" : "they are"}.
        </p>
      )}
    </div>
  );
}

/* ── connecting ── */

function GuideList({ guide }: { guide: GuideEntry[] }) {
  return (
    <ul className="cn-list">
      {guide.map((g) => (
        <li key={g.scope}>
          <strong>{g.grant}</strong>. {g.why}
        </li>
      ))}
    </ul>
  );
}

function Steps({ provider }: { provider: ProviderOption }) {
  switch (provider.id) {
    case "stripe":
      return (
        <ol className="cn-steps">
          <li>
            In your Stripe Dashboard, open <strong>Developers</strong>, then{" "}
            <strong>API keys</strong>, and choose <strong>Create restricted key</strong>. Test mode
            is fine to start with.
          </li>
          <li>
            Leave every permission at <strong>None</strong>, except:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Create the key and paste it below. It starts with <strong>rk_test_</strong> or{" "}
            <strong>rk_live_</strong>.
          </li>
        </ol>
      );
    case "shopify":
      return (
        <ol className="cn-steps">
          <li>
            In Shopify&rsquo;s <strong>Dev Dashboard</strong>, choose <strong>Create app</strong>,
            then <strong>Start from Dev Dashboard</strong>, and name it.
          </li>
          <li>
            In the app&rsquo;s <strong>Versions</strong> tab, add only these Admin API scopes, then
            release the version:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            From the app&rsquo;s <strong>Home</strong>, choose <strong>Install app</strong> and pick
            your store. The app and the store must be in the same Shopify organization.
          </li>
          <li>
            From the app&rsquo;s <strong>Settings</strong>, copy the client ID and client secret,
            and enter them below with your store&rsquo;s myshopify.com address.
          </li>
        </ol>
      );
    case "woocommerce":
      return (
        <ol className="cn-steps">
          <li>
            In WordPress, open <strong>WooCommerce</strong>, then <strong>Settings</strong>,{" "}
            <strong>Advanced</strong>, <strong>REST API</strong>, and choose{" "}
            <strong>Add key</strong>.
          </li>
          <li>
            Set <strong>Permissions</strong> to <strong>Read</strong>. Read access covers:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Generate the key, then enter the consumer key and consumer secret below with your
            store&rsquo;s address.
          </li>
        </ol>
      );
    case "ga4":
      return (
        <ol className="cn-steps">
          <li>
            In <strong>Google Cloud Console</strong>, create a project (or use one), enable the{" "}
            <strong>Google Analytics Data API</strong>, then under <strong>IAM &amp; Admin</strong>,{" "}
            <strong>Service accounts</strong>, create a service account and download a{" "}
            <strong>JSON key</strong> for it.
          </li>
          <li>
            In <strong>Google Analytics</strong>, open <strong>Admin</strong>, then{" "}
            <strong>Property access management</strong>, and add the service account&rsquo;s email
            address with the role:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Copy the property ID from <strong>Admin</strong>, <strong>Property details</strong>, and
            paste it below with the contents of the key file.
          </li>
        </ol>
      );
    case "square":
      return (
        <ol className="cn-steps">
          <li>
            In the <strong>Square Developer Console</strong>, create an application (or open one)
            and copy its <strong>Production access token</strong>.
          </li>
          <li>
            Give it only these permissions:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Paste the token below. Payments rung up in Square — card and cash — are read; cash that
            never goes through the till can&rsquo;t be seen by anything. With the two appointment
            permissions, your Square Appointments bookings are read too.
          </li>
        </ol>
      );
    case "search_console":
      return (
        <ol className="cn-steps">
          <li>
            In <strong>Google Cloud Console</strong>, enable the{" "}
            <strong>Google Search Console API</strong> on a project and create a service account
            with a <strong>JSON key</strong> — the same one you use for Google Analytics is fine.
          </li>
          <li>
            In <strong>Search Console</strong>, open <strong>Settings</strong>, then{" "}
            <strong>Users and permissions</strong>, and add the service account&rsquo;s email:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Enter the property exactly as Search Console names it, with the contents of the key
            file. Rare searches are hidden by Google for privacy, so the searches I read add up to a
            little less than Google&rsquo;s own total.
          </li>
        </ol>
      );
    case "meta_ads":
      return (
        <ol className="cn-steps">
          <li>
            In <strong>Meta Business Suite</strong>, open <strong>Business settings</strong>, then{" "}
            <strong>Users</strong>, <strong>System users</strong>, and add a system user (Employee
            role is enough).
          </li>
          <li>
            Under <strong>Assign assets</strong>, give it your ad account with{" "}
            <strong>View performance</strong> only.
          </li>
          <li>
            Choose <strong>Generate token</strong>, pick your app, and tick only:
            <GuideList guide={provider.guide} />
          </li>
          <li>
            Paste the token below with your ad account ID, which is shown in{" "}
            <strong>Ads Manager</strong>.
          </li>
        </ol>
      );
    default:
      return <GuideList guide={provider.guide} />;
  }
}

function VerificationNote({ provider }: { provider: ProviderOption }) {
  if (provider.scope_verification === "reported") {
    return (
      <p className="cn-note">
        {provider.label} reports exactly which permissions a credential has, and I check them when
        you connect. If it could change anything on your side, I refuse the connection.
      </p>
    );
  }
  return (
    <p className="cn-note">
      {provider.label} doesn&rsquo;t let any app check the rest of a key&rsquo;s permissions. Here
      is what I can promise: I test that the reads above work, and my code can only read.{" "}
      {provider.id === "stripe"
        ? "I refuse full-access keys, and leaving every other permission at None is what makes the key itself read-only."
        : "Choosing Read access is what makes the key itself read-only."}
    </p>
  );
}

/* ── a connected source's settings ── */

function SourceSettings({
  connection: c,
  busy,
  confirming,
  onSync,
  onAskDisconnect,
  onCancel,
  onDisconnect,
}: {
  connection: Connection;
  busy: boolean;
  confirming: boolean;
  onSync: () => void;
  onAskDisconnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}) {
  const [matching, setMatching] = useState(false);

  return (
    <div className="cn-detail">
      <dl className="cn-facts">
        <dt>access</dt>
        <dd>
          <span className="word boxed">read-only</span>{" "}
          <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>{c.status}</span>
        </dd>
        <dt>granted</dt>
        <dd>
          <span className="cn-scope">
            {c.granted_scopes.length > 0 ? c.granted_scopes.join(" · ") : "nothing recorded"}
          </span>
        </dd>
        <dt>checked</dt>
        <dd>{checkedLine(c)}</dd>
        <dt>last sync</dt>
        <dd>{when(c.last_sync_at)}</dd>
        <dt>history</dt>
        <dd>
          {historyLine(c)}
          {c.provider === "shopify" && !c.granted_scopes.includes("read_all_orders")
            ? " Shopify only shows 60 days without read_all_orders, which Shopify must approve."
            : ""}
        </dd>
        {c.last_error !== null && (
          <>
            <dt>last error</dt>
            <dd>
              {c.last_error}
              {c.failure_count > 1 ? ` (${c.failure_count} in a row)` : ""}
            </dd>
          </>
        )}
      </dl>

      <div className="cn-acts">
        {c.status === "connected" && !confirming && (
          <button type="button" className="ghost" disabled={busy} onClick={onSync}>
            {busy ? "Syncing…" : "Sync now"}
          </button>
        )}
        {c.matching !== null && c.status !== "disconnected" && !confirming && (
          <button
            type="button"
            className="ghost"
            aria-pressed={matching}
            disabled={busy}
            onClick={() => setMatching((m) => !m)}
          >
            {matching
              ? "Hide matching"
              : c.matching === "product"
                ? "Match products"
                : "Match channels"}
          </button>
        )}
        {confirming ? (
          <>
            <span className="cn-confirm">
              Disconnect {c.label}? The credential is deleted and syncing stops. The measured
              history stays.
            </span>
            <button type="button" className="ghost" disabled={busy} onClick={onDisconnect}>
              Yes, disconnect
            </button>
            <button type="button" className="ghost quiet" disabled={busy} onClick={onCancel}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="ghost quiet" disabled={busy} onClick={onAskDisconnect}>
            Disconnect
          </button>
        )}
      </div>

      {matching && <MappingPanel connection={c} />}
    </div>
  );
}

/* ── connecting one source ── */

function ConnectPanel({
  provider,
  onConnected,
}: {
  provider: ProviderOption;
  onConnected: (message: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = provider.credential_fields;
  const complete = fields.every((f) => (values[f.name] ?? "").trim() !== "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // One field travels as itself; several travel as one JSON object,
    // encrypted and stored whole (lib/connectors/credentials.ts).
    const only = fields[0];
    const secret =
      fields.length === 1 && only
        ? (values[only.name] ?? "").trim()
        : JSON.stringify(
            Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()])),
          );
    try {
      const { ok, payload } = await send("/api/connections", "POST", {
        provider: provider.id,
        secret,
      });
      if (!ok) {
        setError(errorText(payload, "That didn't connect."));
        return;
      }
      setValues({});
      await onConnected(
        provider.matching === "product"
          ? `${provider.label} is connected. Press Sync now to read your orders, then match your products.`
          : provider.matching === "channel"
            ? `${provider.label} is connected. Press Sync now to read your traffic, then match your channels.`
            : `${provider.label} is connected. Press Sync now to read the last year.`,
      );
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-detail">
      <p className="cn-sub">{provider.label}, read-only</p>
      <Steps provider={provider} />
      <VerificationNote provider={provider} />

      <form className="cn-form" onSubmit={(e) => void submit(e)}>
        {fields.map((f) => (
          <label key={f.name} className="cn-field">
            <span className="cn-field-label">{f.label}</span>
            {f.multiline ? (
              <textarea
                className="cn-input cn-textarea"
                rows={6}
                spellCheck={false}
                placeholder={f.placeholder}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                disabled={busy}
              />
            ) : (
              <input
                className="cn-input"
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                disabled={busy}
              />
            )}
          </label>
        ))}
        {error !== null && (
          <p className="cn-error" role="alert">
            {error}
          </p>
        )}
        <button className="next" type="submit" disabled={busy || !complete}>
          {busy ? "Checking…" : `Connect ${provider.label}`}
        </button>
      </form>
      <p className="cn-note">
        Everything you enter is encrypted before it&rsquo;s stored and never shown again, not even
        to you.
      </p>
    </div>
  );
}

/* ── the screen ── */

interface PanelRow {
  id: string;
  label: string;
  gives: string;
  provider: ProviderOption | null;
  connection: Connection | null;
}

function ReadBox({ c }: { c: Connection | null }) {
  const on = c?.status === "connected";
  return (
    <span className={`cn-box${on ? " on" : ""}`}>
      <span className="sr-only">{on ? "reading" : c ? `not reading, ${c.status}` : "off"}</span>
    </span>
  );
}

export function ConnectionsScreen() {
  const [view, setView] = useState<View | null>(null);
  const [exec, setExec] = useState<ExecView | null>(null);
  // P4-15: campaign email, its own consent.
  const [email, setEmail] = useState<EmailView | null>(null);
  // The headline speaks for writing too, so it waits until that side has answered.
  const [execDone, setExecDone] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "signed_out" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const loadExec = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/execute");
      setExec(res.ok ? ((await res.json()) as ExecView) : null);
    } catch {
      setExec(null);
    } finally {
      setExecDone(true);
    }
  }, []);

  const loadEmail = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/email");
      setEmail(res.ok ? ((await res.json()) as EmailView) : null);
    } catch {
      setEmail(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connections");
      if (res.status === 401) {
        setState("signed_out");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      setView((await res.json()) as View);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadExec();
    void loadEmail();
  }, [load, loadExec, loadEmail]);

  const syncNow = async (c: Connection) => {
    setBusy(c.id);
    setNotice(null);
    try {
      const { ok, payload } = await send("/api/connections/sync", "POST", { id: c.id });
      if (!ok) {
        setNotice(errorText(payload, "The sync didn't run."));
      } else if (payload?.skipped === "locked") {
        setNotice(`A sync is already running for ${c.label}.`);
      } else if (payload?.ok === true) {
        setNotice(`${c.label} synced. ${String(payload.observations ?? 0)} daily figures read.`);
      } else {
        setNotice(`${c.label} didn't sync. ${errorText(payload, "No reason was given.")}`);
      }
      await load();
    } catch {
      setNotice("I couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const disconnectOne = async (c: Connection) => {
    setBusy(c.id);
    try {
      const { ok, payload } = await send("/api/connections", "DELETE", { id: c.id });
      setNotice(
        ok
          ? `${c.label} is disconnected. The credential is deleted, and the measured history stays.`
          : errorText(payload, "That didn't disconnect."),
      );
      setConfirming(null);
      setOpen(null);
      await load();
    } catch {
      setNotice("I couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (state === "loading" || (state === "ready" && !execDone)) {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={KICKER} title="Reading your connections…" aside={ASIDE} />
      </main>
    );
  }
  if (state === "error") {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={KICKER} title="Connections didn't load." aside={ASIDE} />
        <SheetCard label="Connections" title="Something went wrong.">
          <p className="cn-copy">
            Something went wrong loading your connections. Refresh to try again.
          </p>
        </SheetCard>
      </main>
    );
  }
  if (state === "signed_out") {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={KICKER} title="Sign in to connect your numbers." aside={ASIDE} />
        <SheetCard label="Connections" title="Connections belong to your account.">
          <p className="cn-copy">
            A payment account, a till or online shop, or an ad account connects to your account, not
            just to this browser.
          </p>
          <Link className="next" href="/login">
            Sign in <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }
  if (view === null) return null;

  const live = view.connections.filter((c) => c.status !== "disconnected");
  const past = view.connections.filter((c) => c.status === "disconnected");
  const now = Date.now();

  // Every offered source, with its live connection when there is one;
  // a live connection to a source no longer offered still gets its row.
  const rows: PanelRow[] = view.providers.map((p) => ({
    id: p.id,
    label: p.label,
    gives: gives(p.guide),
    provider: p,
    connection: live.find((c) => c.provider === p.id) ?? null,
  }));
  for (const c of live) {
    if (!rows.some((r) => r.id === c.provider)) {
      rows.push({ id: c.provider, label: c.label, gives: "", provider: null, connection: c });
    }
  }

  const title = headline(live, exec ? exec.connections : null);

  return (
    <main className="screen cn-screen">
      <PageHead kicker={KICKER} title={title} aside={ASIDE} />

      {notice !== null && (
        <p className="cn-banner" aria-live="polite">
          {notice}
        </p>
      )}

      <section className="cs cn-panel" aria-labelledby="cn-panel-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Patch panel</p>
            <h2 className="cs-title" id="cn-panel-title">
              What&rsquo;s plugged in
            </h2>
          </div>
          <p className="cs-meta cn-legend" aria-hidden="true">
            <span className="cn-box on" /> on <span className="cn-box" /> off{" "}
            <span className="cn-dash">—</span> never
          </p>
        </header>
        <div className="cn-table-wrap">
          <table className="rt cn-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">What it gives</th>
                <th scope="col" className="cn-c">
                  Read
                </th>
                <th scope="col" className="cn-c">
                  Write
                </th>
                <th scope="col" className="num">
                  Last read
                </th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = r.connection;
                const isOpen = open === r.id;
                const canConnect = c === null && r.provider !== null;
                const panelId = `cn-row-${r.id}`;
                return (
                  <Fragment key={r.id}>
                    <tr className={isOpen ? "on" : undefined}>
                      <th scope="row" className="cn-name" data-label="Source">
                        {r.label}
                      </th>
                      <td className="cn-gives" data-label="What it gives">
                        {r.gives}
                      </td>
                      <td className="cn-c" data-label="Read">
                        <ReadBox c={c} />
                      </td>
                      <td className="cn-c" data-label="Write">
                        <span className="cn-dash" aria-hidden="true">
                          —
                        </span>
                        <span className="sr-only">never — read-only by design</span>
                      </td>
                      <td className="num cn-last" data-label="Last read">
                        {lastRead(c?.last_sync_at ?? null, now)}
                        {c !== null && c.status !== "connected" && (
                          <span className={`word ${c.status === "failed" ? "alarm" : "drift"}`}>
                            {c.status}
                          </span>
                        )}
                      </td>
                      <td className="cn-act">
                        {(c !== null || canConnect) && (
                          <button
                            type="button"
                            className="prop-btn"
                            aria-expanded={isOpen}
                            aria-controls={panelId}
                            onClick={() => {
                              setOpen(isOpen ? null : r.id);
                              setConfirming(null);
                            }}
                          >
                            {isOpen ? (
                              "Close"
                            ) : c !== null ? (
                              "Settings"
                            ) : (
                              <>
                                Connect <span aria-hidden="true">→</span>
                              </>
                            )}
                            <span className="sr-only"> {r.label}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cn-open" id={panelId}>
                        <td colSpan={6}>
                          {c !== null ? (
                            <SourceSettings
                              connection={c}
                              busy={busy === c.id}
                              confirming={confirming === c.id}
                              onSync={() => void syncNow(c)}
                              onAskDisconnect={() => setConfirming(c.id)}
                              onCancel={() => setConfirming(null)}
                              onDisconnect={() => void disconnectOne(c)}
                            />
                          ) : r.provider !== null ? (
                            <ConnectPanel
                              provider={r.provider}
                              onConnected={async (message) => {
                                setNotice(message);
                                setOpen(null);
                                await load();
                              }}
                            />
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="cs-foot cn-foot">
          {past.length > 0 && (
            <ul className="cn-past">
              {past.map((c) => (
                <li key={c.id}>
                  <span className="cn-past-at">
                    {(c.disconnected_at ?? c.created_at).slice(0, 10)}
                  </span>{" "}
                  {c.label} disconnected. The credential was deleted; the measured history it
                  produced stays in your profile.
                </li>
              ))}
            </ul>
          )}
          <p>
            Measured figures replace your estimates in the report, and your estimates stay in your
            history. Google Ads isn&rsquo;t available yet: it needs Ledgerline&rsquo;s own approval
            from Google before any account can connect.
          </p>
        </footer>
      </section>

      {/* Bookings (specs/bookings.md §5): an export from any booking system, read once. */}
      <BookingsImportSection />

      {/* P3-20h: write access, visibly apart from everything above. */}
      {exec !== null && <ExecutionSection view={exec} onChanged={loadExec} />}

      {/* P4-15: campaign email — no token of yours, SYB's own email service, your consent. */}
      {email !== null && <EmailCampaignSection view={email} onChanged={loadEmail} />}
    </main>
  );
}
