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
//
// L-3d: the screen's fixed words are the "connections" catalogue, and so
// are the registry's guide lines and form labels, word for word in English
// (words.ts); dates and counts are the reader's writing. What the server
// words (its errors, the role refusals) stays English until L-4.

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { ExecView } from "./ExecutionSection";
import { ExecutionSection } from "./ExecutionSection";
import type { EmailView } from "./EmailCampaignSection";
import { EmailCampaignSection } from "./EmailCampaignSection";
import type { GoogleView } from "./GoogleBusinessSection";
import { GoogleBusinessSection } from "./GoogleBusinessSection";
import type { TikTokView } from "./TikTokAdsSection";
import { TikTokAdsSection } from "./TikTokAdsSection";
import type { TikTokPostingView } from "./TikTokPostingSection";
import { TikTokPostingSection } from "./TikTokPostingSection";
import type { GoogleAdsView } from "./GoogleAdsSection";
import { GoogleAdsSection } from "./GoogleAdsSection";
import { BankStatementSection } from "./BankStatementSection";
import { BookingsImportSection } from "./BookingsImportSection";
import { headline, lastRead } from "./patch";
import "../../app/connections.css";
import { useRole } from "../auth/RoleContext";
import type { AppLocale } from "../../lib/i18n/locales";
import { bold, useCn, useSaid } from "./useCn";
import type { CnTr } from "./words";
import {
  SHOPIFY_DEFAULT_DAYS,
  givesText,
  guideLine,
  joinSentences,
  moment,
  percent,
  storedDay,
} from "./words";

type Verification = "reported" | "probed";
type Matching = "product" | "channel" | null;

import type { GuideEntry } from "./words";

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

function historyLine(c: Connection, t: CnTr, locale: AppLocale): string {
  const days = c.history_days;
  if (c.cursor === null) {
    return c.status === "connected" ? t("history.notSynced", { days }) : t("history.never");
  }
  const through = Date.parse(`${c.cursor}T00:00:00Z`);
  const windowStart = Date.now() - days * DAY_MS;
  const pct = Math.max(
    0,
    Math.min(100, Math.round(((through - windowStart) / (days * DAY_MS)) * 100)),
  );
  const day = storedDay(c.cursor, locale);
  return pct >= 99
    ? t("history.upToDate", { day, days })
    : t("history.readThrough", { day, share: percent(pct, locale), days });
}

function when(iso: string | null, t: CnTr, locale: AppLocale): string {
  if (iso === null) return t("settings.never");
  return moment(iso, locale);
}

/** A connection's status word: connected, paused, failed or disconnected. */
export function statusWord(t: CnTr, status: string): string {
  return t.has(`status.${status}`) ? t(`status.${status}`) : status;
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

/** The server's refusal (said in the reader's language when it is SYB's own — L-4c), or the fallback. */
const errorText = (payload: Payload, fallback: string, said: (text: string) => string): string =>
  typeof payload?.error === "string" ? said(payload.error) : fallback;

function checkedLine(c: Connection, t: CnTr): string {
  return c.scope_verification === "reported"
    ? t("settings.checkedReported", { label: c.label })
    : t("settings.checkedProbed", { label: c.label });
}

/* ── matching (P2-15, P2-18) ── */

function MappingPanel({ connection }: { connection: Connection }) {
  const { t } = useCn();
  const said = useSaid();
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
        setError(errorText(payload, t("mapping.couldntRead", { label: connection.label }), said));
        return;
      }
      setView(payload as unknown as MappingView);
    } catch {
      setError(t("unreachable"));
    }
  }, [connection.id, connection.label, t, said]);

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
        setError(errorText(payload, t("mapping.notSaved"), said));
        return;
      }
      setView(payload as unknown as MappingView);
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(null);
    }
  };

  if (error !== null && view === null) return <p className="cn-error">{error}</p>;
  if (view === null) {
    return <p className="cn-note">{t("mapping.reading", { label: connection.label })}</p>;
  }
  const kind = view.kind;
  if (view.entities.length === 0) {
    return <p className="cn-note">{t(`mapping.${kind}.none`)}</p>;
  }

  const unmatchedCount = view.unmapped_items.length;
  return (
    <div className="cn-mapping">
      <Fold>
        <p>{t(`mapping.${kind}.intro`, { label: connection.label })}</p>
      </Fold>
      <ul className="cn-map-list">
        {view.entities.map((entity) => {
          const selected = choices[entity.entity_id] ?? entity.suggestion?.ref ?? "";
          return (
            <li key={entity.entity_id} className="cn-map-row">
              <span className="cn-map-offer">{entity.name}</span>
              {entity.mapped !== null ? (
                <span className="cn-map-state">
                  {t.rich("mapping.matchedTo", { ...bold, label: entity.mapped.label_raw })}
                </span>
              ) : entity.no_match ? (
                <span className="cn-map-state">{t(`mapping.${kind}.noMatch`)}</span>
              ) : (
                <span className="cn-map-state">{t("mapping.notMatched")}</span>
              )}
              <span className="cn-map-pick">
                <select
                  className="cn-input"
                  value={selected}
                  aria-label={t(`mapping.${kind}.select`, {
                    label: connection.label,
                    name: entity.name,
                  })}
                  onChange={(e) =>
                    setChoices((prev) => ({ ...prev, [entity.entity_id]: e.target.value }))
                  }
                  disabled={busy !== null}
                >
                  <option value="">{t(`mapping.${kind}.choose`)}</option>
                  {entity.suggestion !== null && (
                    <option value={entity.suggestion.ref}>
                      {t("mapping.suggested", { title: entity.suggestion.title })}
                    </option>
                  )}
                  {view.items
                    .filter((i) => i.ref !== entity.suggestion?.ref)
                    .map((i) => (
                      <option key={i.ref} value={i.ref}>
                        {i.title}
                      </option>
                    ))}
                  <option value={NONE}>{t("mapping.noneOfThese")}</option>
                </select>
                <button
                  className="ghost"
                  disabled={busy !== null || selected === ""}
                  onClick={() => void confirm(entity)}
                >
                  {busy === entity.entity_id ? t("mapping.saving") : t("mapping.confirm")}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {error !== null && <p className="cn-error">{error}</p>}
      {unmatchedCount > 0 && (
        <p className="cn-note">
          {t(`mapping.${kind}.unmatched`, { count: unmatchedCount, label: connection.label })}
        </p>
      )}
    </div>
  );
}

/* ── connecting ── */

function GuideList({ provider }: { provider: ProviderOption }) {
  const { t } = useCn();
  return (
    <ul className="cn-list">
      {provider.guide.map((g, i) => {
        const line = guideLine(t, provider.id, i, g);
        return (
          <li key={g.scope}>
            {t.rich("guide.line", { ...bold, grant: line.grant, why: line.why })}
          </li>
        );
      })}
    </ul>
  );
}

/** Each provider's setup steps, in order; the step that lists the guide says so. */
const STEPS: Readonly<Record<string, { steps: readonly string[]; guideAfter: string }>> = {
  stripe: { steps: ["s1", "s2", "s3"], guideAfter: "s2" },
  shopify: { steps: ["s1", "s2", "s3", "s4"], guideAfter: "s2" },
  woocommerce: { steps: ["s1", "s2", "s3"], guideAfter: "s2" },
  ga4: { steps: ["s1", "s2", "s3"], guideAfter: "s2" },
  square: { steps: ["s1", "s2", "s3"], guideAfter: "s2" },
  search_console: { steps: ["s1", "s2", "s3"], guideAfter: "s2" },
  meta_ads: { steps: ["s1", "s2", "s3", "s4"], guideAfter: "s3" },
};

function Steps({ provider }: { provider: ProviderOption }) {
  const { t } = useCn();
  const plan = STEPS[provider.id];
  if (plan === undefined) return <GuideList provider={provider} />;
  return (
    <ol className="cn-steps">
      {plan.steps.map((step) => (
        <li key={step}>
          {t.rich(`steps.${provider.id}.${step}`, bold)}
          {step === plan.guideAfter && <GuideList provider={provider} />}
        </li>
      ))}
    </ol>
  );
}

function VerificationNote({ provider }: { provider: ProviderOption }) {
  const { t } = useCn();
  return (
    <Fold>
      <p>
        {provider.scope_verification === "reported"
          ? t("verify.reported", { label: provider.label })
          : t(provider.id === "stripe" ? "verify.probedStripe" : "verify.probed", {
              label: provider.label,
            })}
      </p>
    </Fold>
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
  const { t, locale } = useCn();
  const said = useSaid();
  const [matching, setMatching] = useState(false);

  return (
    <div className="cn-detail">
      <dl className="cn-facts">
        <dt>{t("settings.access")}</dt>
        <dd>
          <span className="word boxed">{t("settings.readOnly")}</span>{" "}
          <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
            {statusWord(t, c.status)}
          </span>
        </dd>
        <dt>{t("settings.granted")}</dt>
        <dd>
          <span className="cn-scope">
            {c.granted_scopes.length > 0
              ? c.granted_scopes.join(" · ")
              : t("settings.nothingRecorded")}
          </span>
        </dd>
        <dt>{t("settings.checked")}</dt>
        <dd>{checkedLine(c, t)}</dd>
        <dt>{t("settings.lastSync")}</dt>
        <dd>{when(c.last_sync_at, t, locale)}</dd>
        <dt>{t("settings.history")}</dt>
        <dd>
          {joinSentences(
            [
              historyLine(c, t, locale),
              c.provider === "shopify" && !c.granted_scopes.includes("read_all_orders")
                ? t("settings.shopifyAllOrders", { days: SHOPIFY_DEFAULT_DAYS })
                : "",
            ],
            locale,
          )}
        </dd>
        {c.provider === "shopify" && (
          <>
            <dt>{t("settings.carts")}</dt>
            <dd>
              {joinSentences(
                [
                  t("settings.cartsRead"),
                  c.granted_scopes.includes("read_customers")
                    ? t("settings.cartsCustomers")
                    : t("settings.cartsNoCustomers"),
                ],
                locale,
              )}
            </dd>
          </>
        )}
        {c.last_error !== null && (
          <>
            <dt>{t("settings.lastError")}</dt>
            <dd>
              {joinSentences(
                [
                  said(c.last_error),
                  c.failure_count > 1 ? t("settings.inARow", { count: c.failure_count }) : "",
                ],
                locale,
              )}
            </dd>
          </>
        )}
      </dl>

      <div className="cn-acts">
        {c.status === "connected" && !confirming && (
          <button type="button" className="ghost" disabled={busy} onClick={onSync}>
            {busy ? t("settings.syncing") : t("settings.syncNow")}
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
              ? t("settings.hideMatching")
              : c.matching === "product"
                ? t("settings.matchProducts")
                : t("settings.matchChannels")}
          </button>
        )}
        {confirming ? (
          <>
            <span className="cn-confirm">{t("settings.disconnectAsk", { label: c.label })}</span>
            <button type="button" className="ghost" disabled={busy} onClick={onDisconnect}>
              {t("settings.yesDisconnect")}
            </button>
            <button type="button" className="ghost quiet" disabled={busy} onClick={onCancel}>
              {t("settings.keepIt")}
            </button>
          </>
        ) : (
          <button type="button" className="ghost quiet" disabled={busy} onClick={onAskDisconnect}>
            {t("settings.disconnect")}
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
  const { t } = useCn();
  const said = useSaid();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = provider.credential_fields;
  /** A form field's label and placeholder in the reader's words; the registry's where it is a code. */
  const fieldWords = (f: CredentialField) => {
    const key = `field.${provider.id}.${f.name}`;
    return {
      label: t.has(`${key}.label`) ? t(`${key}.label`) : f.label,
      placeholder: t.has(`${key}.placeholder`) ? t(`${key}.placeholder`) : f.placeholder,
    };
  };
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
        setError(errorText(payload, t("connect.failed"), said));
        return;
      }
      setValues({});
      await onConnected(
        t(
          provider.matching === "product"
            ? "connect.doneProduct"
            : provider.matching === "channel"
              ? "connect.doneChannel"
              : "connect.done",
          { label: provider.label },
        ),
      );
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-detail">
      <p className="cn-sub">{t("connect.sub", { label: provider.label })}</p>
      <Steps provider={provider} />
      <VerificationNote provider={provider} />

      <form className="cn-form" onSubmit={(e) => void submit(e)}>
        {fields.map((f) => (
          <label key={f.name} className="cn-field">
            <span className="cn-field-label">{fieldWords(f).label}</span>
            {f.multiline ? (
              <textarea
                className="cn-input cn-textarea"
                rows={6}
                spellCheck={false}
                placeholder={fieldWords(f).placeholder}
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
                placeholder={fieldWords(f).placeholder}
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
          {busy ? t("connect.checking") : t("connect.button", { label: provider.label })}
        </button>
      </form>
      <p className="cn-note">{t("connect.encrypted")}</p>
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
  const { t } = useCn();
  const on = c?.status === "connected";
  return (
    <span className={`cn-box${on ? " on" : ""}`}>
      <span className="sr-only">
        {on
          ? t("panel.reading")
          : c
            ? t("panel.notReading", { status: statusWord(t, c.status) })
            : t("panel.off")}
      </span>
    </span>
  );
}

export function ConnectionsScreen() {
  // Idea 52: connecting, and granting write access, are an owner's (lib/auth/roles).
  const { t, locale } = useCn();
  const said = useSaid();
  const role = useRole();
  const connectWhy = role.why("connections.manage");
  // I-52b: a manager may read a connected source again, though the panel stays locked.
  const syncWhy = role.why("connections.sync");
  const consentWhy = role.why("write_access.manage");
  const [view, setView] = useState<View | null>(null);
  const [exec, setExec] = useState<ExecView | null>(null);
  // P4-15: campaign email, its own consent.
  const [email, setEmail] = useState<EmailView | null>(null);
  // I-45a: Google Business Profile, its own consent, used only to read reviews.
  const [google, setGoogle] = useState<GoogleView | null>(null);
  // 2026-11-08: TikTok posting, its own consent.
  const [tiktok, setTiktok] = useState<TikTokPostingView | null>(null);
  // P2-20 / P3-22: Google Ads, its own consent — reads spend, changes only what's approved.
  const [gads, setGads] = useState<GoogleAdsView | null>(null);
  // TikTok Ads: reading and acting, one consent (TikTok can't separate them for one app).
  const [ttads, setTtads] = useState<TikTokView | null>(null);
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

  const loadGoogle = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/google-business");
      setGoogle(res.ok ? ((await res.json()) as GoogleView) : null);
    } catch {
      setGoogle(null);
    }
  }, []);

  const loadTiktok = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/tiktok-posting");
      setTiktok(res.ok ? ((await res.json()) as TikTokPostingView) : null);
    } catch {
      setTiktok(null);
    }
  }, []);

  const loadGads = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/google-ads");
      setGads(res.ok ? ((await res.json()) as GoogleAdsView) : null);
    } catch {
      setGads(null);
    }
  }, []);

  const loadTtads = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/tiktok");
      setTtads(res.ok ? ((await res.json()) as TikTokView) : null);
    } catch {
      setTtads(null);
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
    void loadGoogle();
    void loadTiktok();
    void loadGads();
    void loadTtads();
  }, [load, loadExec, loadEmail, loadGoogle, loadTiktok, loadGads, loadTtads]);

  const syncNow = async (c: Connection) => {
    setBusy(c.id);
    setNotice(null);
    try {
      const { ok, payload } = await send("/api/connections/sync", "POST", { id: c.id });
      if (!ok) {
        setNotice(errorText(payload, t("sync.didntRun"), said));
      } else if (payload?.skipped === "locked") {
        setNotice(t("sync.locked", { label: c.label }));
      } else if (payload?.ok === true) {
        const count = typeof payload.observations === "number" ? payload.observations : 0;
        setNotice(t("sync.done", { label: c.label, count }));
      } else {
        setNotice(
          t("sync.failed", {
            label: c.label,
            reason: errorText(payload, t("sync.noReason"), said),
          }),
        );
      }
      await load();
    } catch {
      setNotice(t("unreachable"));
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
          ? t("settings.disconnected", { label: c.label })
          : errorText(payload, t("settings.disconnectFailed"), said),
      );
      setConfirming(null);
      setOpen(null);
      await load();
    } catch {
      setNotice(t("unreachable"));
    } finally {
      setBusy(null);
    }
  };

  if (state === "loading" || (state === "ready" && !execDone)) {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={t("kicker")} title={t("loading")} />
      </main>
    );
  }
  if (state === "error") {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={t("kicker")} title={t("error.title")} />
        <SheetCard label={t("error.label")} title={t("error.cardTitle")}>
          <p className="cn-copy">{t("error.body")}</p>
        </SheetCard>
      </main>
    );
  }
  if (state === "signed_out") {
    return (
      <main className="screen cn-screen">
        <PageHead kicker={t("kicker")} title={t("signedOut.title")} />
        <SheetCard label={t("error.label")} title={t("signedOut.cardTitle")}>
          <p className="cn-copy">{t("signedOut.body")}</p>
          <Link className="next" href="/login">
            {t("signedOut.signIn")} <span aria-hidden="true">→</span>
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
    gives: givesText(t, p.id, p.guide, locale),
    provider: p,
    connection: live.find((c) => c.provider === p.id) ?? null,
  }));
  for (const c of live) {
    if (!rows.some((r) => r.id === c.provider)) {
      rows.push({ id: c.provider, label: c.label, gives: "", provider: null, connection: c });
    }
  }

  // The write side's names in the reader's words (English keeps the server's).
  const writes =
    exec === null
      ? null
      : exec.connections.map((c) => ({
          ...c,
          label:
            locale !== "en" && t.has(`write.label.${c.provider}`)
              ? t(`write.label.${c.provider}`)
              : c.label,
        }));
  const title = headline(live, writes, t, locale);

  return (
    <main className="screen cn-screen">
      <PageHead kicker={t("kicker")} title={title} />

      {notice !== null && (
        <p className="cn-banner" aria-live="polite">
          {notice}
        </p>
      )}
      {connectWhy !== null && (
        <p className="cn-banner" role="note">
          {joinSentences(
            [connectWhy, t(syncWhy === null ? "banner.seeAndRead" : "banner.see")],
            locale,
          )}
        </p>
      )}
      {connectWhy !== null && syncWhy === null && live.some((c) => c.status === "connected") && (
        <div className="cn-acts" aria-label={t("banner.readAgainGroup")}>
          {live
            .filter((c) => c.status === "connected")
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => void syncNow(c)}
              >
                {busy === c.id
                  ? t("banner.readingOne", { label: c.label })
                  : t("banner.readAgain", { label: c.label })}
              </button>
            ))}
        </div>
      )}

      <fieldset className="role-lock" disabled={connectWhy !== null}>
        <section className="cs cn-panel" aria-labelledby="cn-panel-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">{t("panel.label")}</p>
              <h2 className="cs-title" id="cn-panel-title">
                {t("panel.title")}
              </h2>
            </div>
            <p className="cs-meta cn-legend" aria-hidden="true">
              <span className="cn-box on" /> {t("panel.legendOn")} <span className="cn-box" />{" "}
              {t("panel.legendOff")} <span className="cn-dash">-</span> {t("panel.legendNever")}
            </p>
          </header>
          <div className="cn-table-wrap">
            <table className="rt cn-table">
              <thead>
                <tr>
                  <th scope="col">{t("panel.source")}</th>
                  <th scope="col">{t("panel.gives")}</th>
                  <th scope="col" className="cn-c">
                    {t("panel.read")}
                  </th>
                  <th scope="col" className="cn-c">
                    {t("panel.write")}
                  </th>
                  <th scope="col" className="num">
                    {t("panel.lastRead")}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{t("panel.action")}</span>
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
                      <tr id={`cn-src-${r.id}`} className={isOpen ? "on" : undefined}>
                        <th scope="row" className="cn-name" data-label={t("panel.source")}>
                          {r.label}
                        </th>
                        <td className="cn-gives" data-label={t("panel.gives")}>
                          {r.gives}
                        </td>
                        <td className="cn-c" data-label={t("panel.read")}>
                          <ReadBox c={c} />
                        </td>
                        <td className="cn-c" data-label={t("panel.write")}>
                          <span className="cn-dash" aria-hidden="true">
                            -
                          </span>
                          <span className="sr-only">{t("panel.writeNever")}</span>
                        </td>
                        <td className="num cn-last" data-label={t("panel.lastRead")}>
                          {lastRead(c?.last_sync_at ?? null, now, locale)}
                          {c !== null && c.status !== "connected" && (
                            <span className={`word ${c.status === "failed" ? "alarm" : "drift"}`}>
                              {statusWord(t, c.status)}
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
                                t("panel.close")
                              ) : c !== null ? (
                                t("panel.settings")
                              ) : (
                                <>
                                  {t("panel.connect")} <span aria-hidden="true">→</span>
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
                      {storedDay(c.disconnected_at ?? c.created_at, locale)}
                    </span>{" "}
                    {t("panel.past", { label: c.label })}
                  </li>
                ))}
              </ul>
            )}
            <Fold>
              <p>{t("panel.foot")}</p>
            </Fold>
          </footer>
        </section>

        {/* Bookings (specs/bookings.md §5): an export from any booking system, read once. */}
        <BookingsImportSection />
        <BankStatementSection />
      </fieldset>

      <fieldset className="role-lock" disabled={consentWhy !== null}>
        {consentWhy !== null && (
          <p className="cn-banner" role="note">
            {consentWhy}
          </p>
        )}
        {/* P3-20h: write access, visibly apart from everything above. */}
        {exec !== null && <ExecutionSection view={exec} onChanged={loadExec} />}

        {/* P4-15: campaign email — no token of yours, SYB's own email service, your consent. */}
        {email !== null && <EmailCampaignSection view={email} onChanged={loadEmail} />}

        {/* I-45a: Google Business Profile — a permission that can write, used only to read reviews. */}
        {google !== null && (
          <GoogleBusinessSection
            view={google}
            onChanged={async () => {
              // The headline counts every write consent, so it re-reads too.
              await Promise.all([loadGoogle(), loadExec()]);
            }}
          />
        )}

        {/* 2026-11-08: TikTok posting — the videos you approve, private until TikTok's audit. */}
        {tiktok !== null && (
          <TikTokPostingSection
            view={tiktok}
            onChanged={async () => {
              await Promise.all([loadTiktok(), loadExec()]);
            }}
          />
        )}

        {/* P2-20 / P3-22: Google Ads — a permission that can write; SYB reads, and changes only what you approve. */}
        {gads !== null && (
          <GoogleAdsSection
            view={gads}
            onChanged={async () => {
              await Promise.all([loadGads(), loadExec(), load()]);
            }}
          />
        )}

        {/* TikTok Ads — reading and acting are one TikTok permission list, so one consent. */}
        {ttads !== null && (
          <TikTokAdsSection
            view={ttads}
            onChanged={async () => {
              await Promise.all([loadTtads(), loadExec(), load()]);
            }}
          />
        )}
      </fieldset>
    </main>
  );
}
