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

import { useState } from "react";

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
  nothing_sent: string;
  disconnect_note: string;
  connections: ExecConnection[];
  providers: ExecProvider[];
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
  onDone,
}: {
  c: ExecConnection;
  note: string;
  onDone: (message: string) => Promise<void>;
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
      </dl>
      <div className="cn-acts">
        <button type="button" className="ghost" disabled={busy} onClick={() => void disconnect()}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
      {error !== null && (
        <p className="cn-error" role="alert">
          {error}
        </p>
      )}
      <p className="cn-note">{note}</p>
    </div>
  );
}

function ConsentForm({
  provider,
  onDone,
}: {
  provider: ExecProvider;
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

      <p className="cn-sub">Set up your own Meta app</p>
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
  const [open, setOpen] = useState<string | null>(null);

  const live = view.connections.filter((c) => c.status !== "disconnected");
  const done = async (message: string) => {
    setNotice(message);
    setOpen(null);
    await onChanged();
  };

  return (
    <div className="cn-write" aria-label="Write access">
      <section className="cs cn-write-card" aria-labelledby="cn-write-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Write access · a separate consent</p>
            <h2 className="cs-title" id="cn-write-title">
              {live.length === 0 ? "Off. Nothing can publish." : "On, only for what you approve"}
            </h2>
          </div>
        </header>
        <div className="cs-body cn-write-body">
          {view.providers.map((p) => {
            const c = live.find((x) => x.provider === p.id) ?? null;
            const isOpen = open === p.id;
            return (
              <div key={p.id} className="cn-wp">
                <div className="cn-wp-head">
                  <div>
                    <h3 className="cn-wp-name">{p.label}</h3>
                    <p className="cn-wp-state">
                      {c ? `consented ${c.created_at.slice(0, 10)} · ${c.status}` : "not granted"}
                    </p>
                  </div>
                  {c === null && (
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
                {c !== null && <ConnectedWrite c={c} note={view.disconnect_note} onDone={done} />}
                {c === null && isOpen && <ConsentForm provider={p} onDone={done} />}
              </div>
            );
          })}
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
