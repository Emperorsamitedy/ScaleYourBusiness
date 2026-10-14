"use client";

// The Execution section of /connections — P3-20h/i (Session D, layer D1).
//
// Write access, kept visibly apart from the read-only Measurement cards:
// its own heading, its own colour, its own badge. What it renders is data:
// the consent lines come verbatim from the execution scope registry, the
// setup steps and the confirmation phrase from lib/execution/setup, and
// the access-level wording from META_ACCESS_LEVEL (P3-20i), so the screen
// cannot promise more than the code declares or Meta has approved.

import { useCallback, useEffect, useState } from "react";

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

interface ExecProvider {
  id: string;
  label: string;
  consent: ConsentEntry[];
  readback_scopes: string[];
  operations: Operation[];
  confirm_phrase: string | null;
  credential_fields: Field[];
  own_app_steps: string[];
}

interface ExecConnection {
  id: string;
  provider: string;
  label: string;
  status: "connected" | "paused" | "failed" | "disconnected";
  granted_scopes: string[];
  created_at: string;
  disconnected_at: string | null;
}

interface ExecView {
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

function ExecConnectionCard({
  c,
  note,
  onDisconnected,
}: {
  c: ExecConnection;
  note: string;
  onDisconnected: (message: string) => Promise<void>;
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
      await onDisconnected(`${c.label} is disconnected. The token is deleted here.`);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card ops-card exec-card">
      <div className="conn-head">
        <h2 className="conn-name">{c.label}</h2>
        <span className="conn-badges">
          <span className="conn-badge write">can write</span>
          <span className={c.status === "failed" ? "conn-badge problem" : "conn-badge"}>
            {c.status}
          </span>
        </span>
      </div>
      <dl className="conn-facts">
        <dt>permissions</dt>
        <dd>
          <span className="conn-scope">{c.granted_scopes.join(" · ")}</span>
        </dd>
        <dt>consented</dt>
        <dd>{c.created_at.slice(0, 10)}</dd>
      </dl>
      <div className="conn-actions">
        <button className="ghost" disabled={busy} onClick={() => void disconnect()}>
          {busy ? "disconnecting…" : "Disconnect"}
        </button>
      </div>
      {error !== null && <p className="auth-error">{error}</p>}
      <p className="conn-note">{note}</p>
    </section>
  );
}

function ConsentForm({
  provider,
  nothingSent,
  onConnected,
}: {
  provider: ExecProvider;
  nothingSent: string;
  onConnected: (message: string) => Promise<void>;
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
      await onConnected(`${provider.label} is connected, and your consent is on record.`);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card ops-card exec-card">
      <div className="conn-head">
        <h2 className="conn-name">{provider.label}</h2>
        <span className="conn-badges">
          <span className="conn-badge write">can write</span>
        </span>
      </div>

      <span className="auth-eyebrow" style={{ marginTop: 14 }}>
        what you allow
      </span>
      <ul className="mode-reasons">
        {provider.consent.map((c) => (
          <li key={c.scope}>
            {c.why} <span className="conn-scope">{c.grant}</span>
          </li>
        ))}
      </ul>
      <ul className="mode-reasons">
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
        <p className="conn-note">
          To see how each post does, the same token also reads:{" "}
          <span className="conn-scope">{provider.readback_scopes.join(" · ")}</span>
        </p>
      )}

      <span className="auth-eyebrow" style={{ marginTop: 14 }}>
        set up your own Meta app
      </span>
      <ol className="conn-steps">
        {provider.own_app_steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <form className="conn-form" onSubmit={(e) => void submit(e)}>
        {provider.credential_fields.map((f) => (
          <input
            key={f.name}
            className="field"
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            aria-label={`${provider.label} ${f.label}`}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
            disabled={busy}
          />
        ))}
        <label className="auth-copy" htmlFor={`confirm-${provider.id}`}>
          To confirm, type <strong>{phrase}</strong>
        </label>
        <input
          id={`confirm-${provider.id}`}
          className="field"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
        />
        {error !== null && <p className="auth-error">{error}</p>}
        <button className="next" type="submit" disabled={busy || !complete || !confirmed}>
          {busy ? "checking…" : `Allow and connect`}
        </button>
      </form>
      <p className="conn-note">{nothingSent}</p>
    </section>
  );
}

export function ExecutionSection() {
  const [view, setView] = useState<ExecView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connections/execute");
      if (res.ok) setView((await res.json()) as ExecView);
    } catch {
      // The Measurement section above already reports an unreachable server.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (view === null) return null;

  const live = view.connections.filter((c) => c.status !== "disconnected");
  const connectable = view.providers.filter((p) => !live.some((c) => c.provider === p.id));
  const done = async (message: string) => {
    setNotice(message);
    await load();
  };

  return (
    <>
      <h2 className="exec-heading">Execution · write access</h2>
      <section className="card ops-card exec-card">
        <span className="auth-eyebrow">meta access level: {view.access.level}</span>
        <p className="auth-copy">
          <strong>{view.access.headline}</strong> {view.access.body}
        </p>
        <ul className="mode-reasons">
          {view.access.routes.map((r) => (
            <li key={r.title}>
              <strong>{r.title}</strong>
              {r.available ? "" : " (unavailable)"} — {r.detail}
            </li>
          ))}
        </ul>
        {notice !== null && (
          <p className="auth-copy" aria-live="polite">
            {notice}
          </p>
        )}
      </section>

      {live.map((c) => (
        <ExecConnectionCard key={c.id} c={c} note={view.disconnect_note} onDisconnected={done} />
      ))}
      {connectable.map((p) => (
        <ConsentForm key={p.id} provider={p} nothingSent={view.nothing_sent} onConnected={done} />
      ))}
    </>
  );
}
