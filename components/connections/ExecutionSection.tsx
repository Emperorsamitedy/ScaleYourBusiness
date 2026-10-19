"use client";

// The write-access section of /connections — P3-20h/i (Session D, layer
// D1), in the owner's Connections design (2026-10-17).
//
// Write access, kept visibly apart from the read-only patch panel: its own
// sheet, its own consent, its own confirmation phrase. What it renders is
// data: the consent lines come verbatim from the execution scope registry,
// the setup steps and the confirmation phrase from lib/execution/setup,
// and the access-level wording from META_ACCESS_LEVEL (P3-20i), so the
// screen cannot promise more than the code declares or Meta has approved.
// Granting records consent; it never runs anything by itself (rule 12).
//
// Two ways in (the pilot routes): invited testers sign in with Facebook
// (P3-20j) — the phrase is typed here first, Meta's dialog asks for the
// listed permissions, and the owner picks the Page or ad account from what
// the server lists — or the owner pastes a token from their own Meta app.
// Both land in the same exact-scope check and the same consent row.
//
// P3-24b: a write connection whose sign-in Meta refused pauses itself. It
// shows here as `paused`, with the reason in Meta's terms said in ours, and
// one Reconnect action that opens the same two ways in; reconnecting
// replaces the paused credential and the held work picks up where it left
// off. No icons: the state is a mono status word and a sentence.

import { useEffect, useState } from "react";

interface ConsentEntry {
  scope: string;
  grant: string;
  why: string;
}

interface Operation {
  op: string;
  description: string;
  reversible: boolean;
}

interface Field {
  name: string;
  label: string;
  placeholder: string;
  secret: boolean;
  optional?: boolean;
}

export interface ExecProvider {
  id: string;
  label: string;
  consent: ConsentEntry[];
  readback_scopes: string[];
  operations: Operation[];
  confirm_phrase: string | null;
  credential_fields: Field[];
  own_app_steps: string[];
}

export interface ExecConnection {
  id: string;
  provider: string;
  label: string;
  status: "connected" | "paused" | "failed" | "disconnected";
  granted_scopes: string[];
  /** Why it paused itself, in the owner's words (P3-24b) — the classified Meta refusal. */
  last_error?: string | null;
  /** P3-22d, meta_ads: the access tier Meta last reported, verbatim, and in words. */
  access_tier?: string | null;
  access_tier_seen_at?: string | null;
  access_tier_words?: string | null;
  created_at: string;
  disconnected_at: string | null;
}

export interface ExecView {
  access: {
    level: "standard" | "advanced";
    headline: string;
    body: string;
    routes: { title: string; available: boolean; detail: string }[];
  };
  /** P3-20j: Facebook Login for invited testers, armed only when SYB's Meta app keys are set. */
  facebook_login: {
    available: boolean;
    tester_note: string;
    one_consent_note: string;
    off_note: string;
  };
  nothing_sent: string;
  disconnect_note: string;
  /** P3-22d: what the ads access tier means, shown under the ad connection. */
  ads_access_note?: string;
  connections: ExecConnection[];
  providers: ExecProvider[];
}

interface PageCandidate {
  id: string;
  name: string;
  instagram: { id: string; username: string | null } | null;
}

interface AdAccountCandidate {
  id: string;
  name: string;
  account_status: number | null;
}

type Candidates =
  | { provider: string; kind: "pages"; candidates: PageCandidate[] }
  | { provider: string; kind: "ad_accounts"; candidates: AdAccountCandidate[] };

/** What the Facebook sign-in's redirect back to /connections says, read once from the URL. */
interface LoginReturn {
  kind: "pick" | "cancelled" | "error";
  provider: string | null;
  message: string | null;
}

function readLoginReturn(): LoginReturn | null {
  const q = new URLSearchParams(window.location.search);
  const meta = q.get("meta");
  if (meta !== "pick" && meta !== "cancelled" && meta !== "error") return null;
  return { kind: meta, provider: q.get("provider"), message: q.get("message") };
}

/** The flow's query off the address bar, so a reload doesn't replay it. */
function clearLoginReturn(): void {
  const url = new URL(window.location.href);
  for (const key of ["meta", "provider", "message"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

type Payload = Record<string, unknown> | null;

async function send(
  method: "POST" | "DELETE",
  body: unknown,
): Promise<{ ok: boolean; payload: Payload }> {
  const res = await fetch("/api/connections/execute", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, payload: (await res.json().catch(() => null)) as Payload };
}

const errorText = (payload: Payload, fallback: string): string =>
  typeof payload?.error === "string" ? payload.error : fallback;

function ConsentLines({ provider }: { provider: ExecProvider }) {
  return (
    <ul className="cn-consent">
      {provider.consent.map((c) => (
        <li key={c.scope}>
          <span className="cn-consent-why">{c.why}</span>
          <span className="cn-scope">{c.grant}</span>
        </li>
      ))}
    </ul>
  );
}

function ConnectedWrite({
  c,
  note,
  tierNote,
  onDone,
  onReconnect,
  reconnecting,
}: {
  c: ExecConnection;
  note: string;
  /** P3-22d: shown under an ad connection, beside its access tier. */
  tierNote: string | null;
  onDone: (message: string) => Promise<void>;
  /** P3-24b: open the two ways in again, for a paused connection. */
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await send("DELETE", { id: c.id });
      if (!ok) {
        setError(errorText(payload, "That didn't disconnect."));
        return;
      }
      await onDone(`${c.label} is disconnected. The token is deleted here.`);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-wp-detail">
      <dl className="cn-facts">
        <dt>status</dt>
        <dd>
          <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>{c.status}</span>
        </dd>
        <dt>permissions</dt>
        <dd>
          <span className="cn-scope">{c.granted_scopes.join(" · ")}</span>
        </dd>
        <dt>consented</dt>
        <dd>{c.created_at.slice(0, 10)}</dd>
        {c.access_tier_words != null && (
          <>
            <dt>access tier</dt>
            <dd>
              {c.access_tier != null && <span className="cn-scope">{c.access_tier}</span>}{" "}
              {c.access_tier_words}
              {c.access_tier_seen_at != null && ` · seen ${c.access_tier_seen_at.slice(0, 10)}`}
            </dd>
          </>
        )}
      </dl>
      {c.status === "paused" && (
        <p className="cn-error" role="alert">
          {c.last_error ??
            "Meta stopped accepting this connection's sign-in. Reconnect it and I'll pick up where I left off."}
        </p>
      )}
      <div className="cn-acts">
        {c.status === "paused" && (
          <button
            type="button"
            className="prop-btn"
            aria-expanded={reconnecting}
            aria-controls={`cn-grant-${c.provider}`}
            onClick={onReconnect}
          >
            {reconnecting ? "Close" : "Reconnect"}
          </button>
        )}
        <button type="button" className="ghost" disabled={busy} onClick={() => void disconnect()}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
      {error !== null && (
        <p className="cn-error" role="alert">
          {error}
        </p>
      )}
      {tierNote !== null && c.access_tier_words != null && <p className="cn-note">{tierNote}</p>}
      <p className="cn-note">{note}</p>
    </div>
  );
}

/**
 * Pilot route 1 (P3-20j): the phrase is typed HERE, before Meta is ever
 * involved; the form then posts to the start route, which checks it again
 * and sends the owner to Meta's dialog. A plain form post, so the browser
 * follows the redirect itself.
 */
function FacebookSignIn({
  provider,
  login,
}: {
  provider: ExecProvider;
  login: ExecView["facebook_login"];
}) {
  const [typed, setTyped] = useState("");
  const [leaving, setLeaving] = useState(false);
  const phrase = provider.confirm_phrase ?? "";
  const confirmed = phrase !== "" && typed.trim().toLowerCase() === phrase;
  const asset = provider.id === "meta_ads" ? "ad account" : "Page";

  return (
    <>
      <p className="cn-sub">Invited testers: sign in with Facebook</p>
      {login.available ? (
        <>
          <p className="cn-note">{login.tester_note}</p>
          <p className="cn-note">{login.one_consent_note}</p>
          <form
            className="cn-form"
            method="post"
            action="/api/connections/meta/start"
            onSubmit={() => setLeaving(true)}
          >
            <input type="hidden" name="provider" value={provider.id} />
            <label className="cn-field">
              <span className="cn-field-label">
                To confirm, type <strong>{phrase}</strong>
              </span>
              <input
                className="cn-input"
                type="text"
                name="confirmation"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={leaving}
              />
            </label>
            <button className="next" type="submit" disabled={leaving || !confirmed}>
              {leaving ? "Opening Facebook…" : `Sign in with Facebook and pick the ${asset}`}
            </button>
          </form>
        </>
      ) : (
        <div className="cn-acts">
          <button type="button" className="ghost" disabled>
            Sign in with Facebook
          </button>
          <span className="cn-note">{login.off_note}</span>
        </div>
      )}
    </>
  );
}

/**
 * After Meta sends the owner back: the Pages (with their linked Instagram
 * account) or ad accounts the sign-in reaches, listed by the server from
 * Meta. The token never comes to the browser; only the picked id goes back.
 */
function MetaPicker({
  provider,
  onDone,
  onCancel,
}: {
  provider: ExecProvider;
  onDone: (message: string) => Promise<void>;
  onCancel: (message: string) => void;
}) {
  const [list, setList] = useState<Candidates | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/connections/meta/candidates?provider=${encodeURIComponent(provider.id)}`,
        );
        const payload = (await res.json().catch(() => null)) as Payload;
        if (!live) return;
        if (!res.ok) {
          setError(errorText(payload, "I couldn't list what Meta shared."));
          return;
        }
        const got = payload as unknown as Candidates;
        setList(got);
        if (got.candidates.length === 1) setPicked(got.candidates[0]?.id ?? "");
      } catch {
        if (live) setError("I couldn't reach the server. Try again.");
      }
    })();
    return () => {
      live = false;
    };
  }, [provider.id]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/meta/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, asset_id: picked }),
      });
      const payload = (await res.json().catch(() => null)) as Payload;
      if (!res.ok) {
        setError(errorText(payload, "That didn't connect."));
        return;
      }
      await onDone(
        `${provider.label} is connected through Facebook, and your consent is on record.`,
      );
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    await fetch("/api/connections/meta/candidates", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    onCancel("Facebook sign-in cancelled. Nothing was connected, and SYB kept no token.");
  };

  const what = provider.id === "meta_ads" ? "ad account" : "Page";
  return (
    <div className="cn-wp-detail" id={`cn-pick-${provider.id}`}>
      <p className="cn-sub">Pick the {what} SYB may act on</p>
      {list === null && error === null && <p className="cn-note">Asking Meta what you shared…</p>}
      {list !== null && (
        <ul className="cn-pick" role="radiogroup" aria-label={`Pick the ${what}`}>
          {list.kind === "pages"
            ? list.candidates.map((p) => (
                <li key={p.id}>
                  <label className="cn-pick-row">
                    <input
                      type="radio"
                      name={`cn-pick-${provider.id}`}
                      value={p.id}
                      checked={picked === p.id}
                      onChange={() => setPicked(p.id)}
                      disabled={busy}
                    />
                    <span className="cn-pick-name">{p.name}</span>
                    <span className="cn-pick-meta">
                      {p.instagram
                        ? `Instagram ${p.instagram.username ? `@${p.instagram.username}` : p.instagram.id} too`
                        : "no Instagram account linked: Facebook only"}
                    </span>
                  </label>
                </li>
              ))
            : list.candidates.map((a) => (
                <li key={a.id}>
                  <label className="cn-pick-row">
                    <input
                      type="radio"
                      name={`cn-pick-${provider.id}`}
                      value={a.id}
                      checked={picked === a.id}
                      onChange={() => setPicked(a.id)}
                      disabled={busy}
                    />
                    <span className="cn-pick-name">{a.name}</span>
                    <span className="cn-pick-meta">
                      act_{a.id} · {a.account_status === 1 ? "active" : "not active"}
                    </span>
                  </label>
                </li>
              ))}
        </ul>
      )}
      {error !== null && (
        <p className="cn-error" role="alert">
          {error}
        </p>
      )}
      <div className="cn-acts">
        <button
          type="button"
          className="next"
          disabled={busy || list === null || picked === ""}
          onClick={() => void connect()}
        >
          {busy ? "Checking…" : `Allow and connect this ${what}`}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
      <p className="cn-note">
        SYB checks with Meta that the sign-in holds exactly the permissions listed above before
        anything is stored.
      </p>
    </div>
  );
}

function ConsentForm({
  provider,
  login,
  onDone,
}: {
  provider: ExecProvider;
  login: ExecView["facebook_login"];
  onDone: (message: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const phrase = provider.confirm_phrase ?? "";
  const complete = provider.credential_fields.every(
    (f) => f.optional === true || (values[f.name] ?? "").trim() !== "",
  );
  const confirmed = phrase !== "" && typed.trim().toLowerCase() === phrase;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const secret = JSON.stringify(
      Object.fromEntries(
        provider.credential_fields.map((f) => [f.name, (values[f.name] ?? "").trim()]),
      ),
    );
    try {
      const { ok, payload } = await send("POST", {
        provider: provider.id,
        secret,
        confirmation: typed,
      });
      if (!ok) {
        setError(errorText(payload, "That didn't connect."));
        return;
      }
      setValues({});
      setTyped("");
      await onDone(`${provider.label} is connected, and your consent is on record.`);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-wp-detail" id={`cn-grant-${provider.id}`}>
      <p className="cn-sub">What each action does</p>
      <ul className="cn-list">
        {provider.operations.map((o) => (
          <li key={o.op}>
            {o.description}{" "}
            {o.reversible
              ? "Can be undone."
              : "Can't be undone, and is labelled before you approve it."}
          </li>
        ))}
      </ul>
      {provider.readback_scopes.length > 0 && (
        <p className="cn-note">
          To see how each post does, the same token also reads:{" "}
          <span className="cn-scope">{provider.readback_scopes.join(" · ")}</span>
        </p>
      )}

      <FacebookSignIn provider={provider} login={login} />

      <p className="cn-sub">Or: set up your own Meta app</p>
      <ol className="cn-steps">
        {provider.own_app_steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <form className="cn-form" onSubmit={(e) => void submit(e)}>
        {provider.credential_fields.map((f) => (
          <label key={f.name} className="cn-field">
            <span className="cn-field-label">
              {f.label}
              {f.optional ? " (optional)" : ""}
            </span>
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
          </label>
        ))}
        <label className="cn-field">
          <span className="cn-field-label">
            To confirm, type <strong>{phrase}</strong>
          </span>
          <input
            className="cn-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
          />
        </label>
        {error !== null && (
          <p className="cn-error" role="alert">
            {error}
          </p>
        )}
        <button className="next" type="submit" disabled={busy || !complete || !confirmed}>
          {busy ? "Checking…" : "Allow and connect"}
        </button>
      </form>
    </div>
  );
}

export function ExecutionSection({
  view,
  onChanged,
}: {
  view: ExecView;
  onChanged: () => Promise<void>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  // The Facebook sign-in comes back to /connections with its outcome in the query.
  useEffect(() => {
    const back = readLoginReturn();
    if (back === null) return;
    clearLoginReturn();
    const known = view.providers.some((p) => p.id === back.provider);
    if (back.kind === "pick" && known) {
      setPicking(back.provider);
    } else if (back.kind === "cancelled") {
      setNotice("You cancelled the Facebook sign-in. Nothing was connected.");
    } else {
      setFailure(back.message ?? "Facebook sign-in didn't finish. Nothing was connected.");
      if (known) setOpen(back.provider);
    }
    // Read once, on arrival: the query is cleared above, so a re-render finds nothing.
  }, []);

  // Meta's write access only: campaign email (P4-15) has its own section.
  const live = view.connections.filter(
    (c) => c.status !== "disconnected" && view.providers.some((p) => p.id === c.provider),
  );
  const anyPaused = live.some((c) => c.status === "paused");
  const done = async (message: string) => {
    setNotice(message);
    setFailure(null);
    setOpen(null);
    setPicking(null);
    await onChanged();
  };

  return (
    <div className="cn-write" aria-label="Write access">
      <section className="cs cn-write-card" aria-labelledby="cn-write-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Write access · a separate consent</p>
            <h2 className="cs-title" id="cn-write-title">
              {live.length === 0
                ? "Off. Nothing can publish."
                : anyPaused
                  ? "Paused. Reconnect to carry on."
                  : "On, only for what you approve"}
            </h2>
          </div>
        </header>
        <div className="cs-body cn-write-body">
          {view.providers.map((p) => {
            const c = live.find((x) => x.provider === p.id) ?? null;
            const isOpen = open === p.id;
            // P3-24b: a paused connection is granted again through the same two ways in.
            const grantable = c === null || c.status === "paused";
            return (
              <div key={p.id} className="cn-wp">
                <div className="cn-wp-head">
                  <div>
                    <h3 className="cn-wp-name">{p.label}</h3>
                    <p className="cn-wp-state">
                      {c ? `consented ${c.created_at.slice(0, 10)} · ${c.status}` : "not granted"}
                    </p>
                  </div>
                  {c === null && picking !== p.id && (
                    <button
                      type="button"
                      className="prop-btn"
                      aria-expanded={isOpen}
                      aria-controls={`cn-grant-${p.id}`}
                      onClick={() => setOpen(isOpen ? null : p.id)}
                    >
                      {isOpen ? "Close" : "Grant"}
                    </button>
                  )}
                </div>
                <ConsentLines provider={p} />
                {c !== null && (
                  <ConnectedWrite
                    c={c}
                    note={view.disconnect_note}
                    tierNote={view.ads_access_note ?? null}
                    onDone={done}
                    onReconnect={() => setOpen(isOpen ? null : p.id)}
                    reconnecting={isOpen}
                  />
                )}
                {grantable && picking === p.id && (
                  <MetaPicker
                    provider={p}
                    onDone={done}
                    onCancel={(message) => {
                      setPicking(null);
                      setNotice(message);
                    }}
                  />
                )}
                {grantable && isOpen && picking !== p.id && (
                  <ConsentForm provider={p} login={view.facebook_login} onDone={done} />
                )}
              </div>
            );
          })}
          {failure !== null && (
            <p className="cn-error" role="alert">
              {failure}
            </p>
          )}
          {notice !== null && (
            <p className="cn-notice" aria-live="polite">
              {notice}
            </p>
          )}
        </div>
        <footer className="cs-foot">{view.nothing_sent}</footer>
      </section>

      <section className="cn-access" aria-labelledby="cn-access-title">
        <p className="cn-access-label">Meta access level · {view.access.level}</p>
        <h2 className="cn-access-title" id="cn-access-title">
          {view.access.headline}
        </h2>
        <p className="cn-access-body">{view.access.body}</p>
        <ul className="cn-routes">
          {view.access.routes.map((r) => (
            <li key={r.title}>
              <span className="cn-route-title">
                {r.title}
                <span className={`word ${r.available ? "ok" : "low"}`}>
                  {r.available ? "available" : "unavailable"}
                </span>
              </span>
              <span className="cn-route-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
