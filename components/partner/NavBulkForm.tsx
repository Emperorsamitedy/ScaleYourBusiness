"use client";

// NAV Online Számla across the book (multi-market spec §E.4, bookkeeper
// path): one row per client the firm may help connect, four fields each,
// one submit. Each answer comes back as an outcome per client — and, when
// NAV accepted it, the name NAV holds for that business. The secret fields
// are cleared once sent, whatever the answer. Words arrive translated.

import { useState } from "react";

export type NavClient = { profile_id: string; name: string; nav: "connected" | "failed" | "none" };
type Outcome = { client: string; outcome: string; taxpayer_name?: string | null };
type Row = { login: string; password: string; signature_key: string; tax_number: string };

const EMPTY: Row = { login: "", password: "", signature_key: "", tax_number: "" };
const FIELDS = ["login", "password", "signature_key", "tax_number"] as const;

export function NavBulkForm({
  clients,
  words,
}: {
  clients: NavClient[];
  /** Translated: col.*, state.*, outcome.* (connected with {name}), submit, working, summary, revoke, revokeConfirm, revoked, failed (with {why}). */
  words: Record<string, string>;
}) {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const w = (k: string) => words[k] ?? k;
  const open = clients.filter((c) => c.nav !== "connected");

  function set(id: string, field: keyof Row, v: string) {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), [field]: v } }));
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/partner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(answer.error ?? res.status));
    return answer;
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSummary(null);
    const sent = open.map((c) => ({ client: c.profile_id, ...(rows[c.profile_id] ?? EMPTY) }));
    // The secrets leave the page's memory as soon as they are sent.
    setRows((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([id, r]) => [id, { ...r, password: "", signature_key: "" }]),
      ),
    );
    try {
      const answer = await post({ action: "nav_connect", rows: sent });
      const results = (answer.results as Outcome[]) ?? [];
      setOutcomes(Object.fromEntries(results.map((r) => [r.client, r])));
      const n = (k: string) => Number(answer[k] ?? 0);
      setSummary(
        w("summary")
          .replace("{connected}", String(n("connected")))
          .replace("{rejected}", String(n("rejected")))
          .replace("{skipped}", String(n("skipped")))
          .replace(
            "{other}",
            String(
              n("not_found") +
                n("already_connected") +
                n("not_configured") +
                n("rate_limited") +
                n("failed"),
            ),
          ),
      );
    } catch (error) {
      setSummary(w("failed").replace("{why}", error instanceof Error ? error.message : "network"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(w("revokeConfirm"))) return;
    setBusy(true);
    try {
      await post({ action: "nav_revoke", client: id });
      window.alert(w("revoked"));
      window.location.reload();
    } catch (error) {
      setSummary(w("failed").replace("{why}", error instanceof Error ? error.message : "network"));
      setBusy(false);
    }
  }

  const said = (o: Outcome | undefined) =>
    !o
      ? null
      : o.outcome === "connected" && o.taxpayer_name
        ? w("outcome.connected").replace("{name}", o.taxpayer_name)
        : o.outcome === "connected"
          ? w("state.connected")
          : w(`outcome.${o.outcome}`);

  return (
    <form onSubmit={connect} autoComplete="off">
      <div className="partner-table-wrap">
        <table className="rt partner-table">
          <thead>
            <tr>
              {["client", "state", ...FIELDS].map((c) => (
                <th key={c} scope="col">
                  {w(`col.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const r = rows[c.profile_id] ?? EMPTY;
              const o = outcomes[c.profile_id];
              return (
                <tr key={c.profile_id}>
                  <td>{c.name}</td>
                  <td>
                    {w(`state.${c.nav}`)}
                    {o && (
                      <>
                        <br />
                        <b role="status">{said(o)}</b>
                      </>
                    )}
                  </td>
                  {c.nav === "connected" ? (
                    <td colSpan={FIELDS.length}>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => revoke(c.profile_id)}
                      >
                        {w("revoke")}
                      </button>
                    </td>
                  ) : (
                    FIELDS.map((f) => (
                      <td key={f}>
                        <input
                          aria-label={`${w(`col.${f}`)} · ${c.name}`}
                          type={f === "password" || f === "signature_key" ? "password" : "text"}
                          autoComplete={f === "password" ? "new-password" : "off"}
                          spellCheck={false}
                          value={r[f]}
                          onChange={(e) => set(c.profile_id, f, e.target.value)}
                        />
                      </td>
                    ))
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open.length > 0 && (
        <p className="auth-copy">
          <button type="submit" className="act" disabled={busy}>
            {busy ? w("working") : w("submit")}
          </button>
        </p>
      )}
      {summary && (
        <p className="auth-copy" role="status">
          {summary}
        </p>
      )}
    </form>
  );
}
