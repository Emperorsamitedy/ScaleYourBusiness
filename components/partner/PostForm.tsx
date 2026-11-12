"use client";

// One small form for the Partner Console and the owner's mandates page:
// it posts its fields (plus fixed ones) as JSON to an endpoint, then either
// shows `done` — with {key} filled from the answer, nested keys flattened
// ("emails.sent" → {sent}) — follows an answer's `next`, or reloads.
// Labels arrive already translated from the server.

import { useState } from "react";

export type Field =
  | { name: string; label: string; kind: "text" | "textarea" | "number"; initial?: string }
  | {
      name: string;
      label: string;
      kind: "select";
      options: { value: string; label: string }[];
      initial?: string;
    }
  | {
      name: string;
      label: string;
      kind: "checkboxes";
      options: { value: string; label: string }[];
      initial?: string[];
    };

function flatten(o: unknown, out: Record<string, string> = {}): Record<string, string> {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, out);
      else out[k] = Array.isArray(v) ? String(v.length) : String(v);
    }
  }
  return out;
}

export function PostForm({
  endpoint,
  fixed,
  fields = [],
  submit,
  done,
  failed,
  className = "act",
}: {
  endpoint: string;
  fixed: Record<string, unknown>;
  fields?: Field[];
  submit: string;
  done?: string;
  /** With {why}. */
  failed: string;
  className?: string;
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.name, f.initial ?? (f.kind === "checkboxes" ? [] : "")]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { ...fixed };
      for (const f of fields) {
        const v = values[f.name];
        body[f.name] = f.kind === "number" ? Number.parseInt(String(v), 10) : v;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setMsg(failed.replace("{why}", String(answer.error ?? res.status)));
        return;
      }
      if (typeof answer.next === "string") {
        window.location.assign(answer.next);
        return;
      }
      if (done) {
        const flat = flatten(answer);
        setMsg(
          done.replace(
            /\{(\w+)\}/g,
            (_, k: string) =>
              flat[k] ?? flat[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? "0",
          ),
        );
      } else {
        window.location.reload();
      }
    } catch {
      setMsg(failed.replace("{why}", "network"));
    } finally {
      setBusy(false);
    }
  }

  const set = (name: string, v: string | string[]) => setValues((prev) => ({ ...prev, [name]: v }));
  return (
    <form className="entry-col" onSubmit={go}>
      {fields.map((f) => (
        <label key={f.name} className="entry-q">
          <span>{f.label}</span>
          {f.kind === "textarea" ? (
            <textarea
              rows={6}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
            />
          ) : f.kind === "select" ? (
            <select
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
            >
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.kind === "checkboxes" ? (
            <span className="entry-col">
              {f.options.map((o) => {
                const list = (values[f.name] as string[]) ?? [];
                return (
                  <label key={o.value}>
                    <input
                      type="checkbox"
                      checked={list.includes(o.value)}
                      onChange={(e) =>
                        set(
                          f.name,
                          e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value),
                        )
                      }
                    />{" "}
                    {o.label}
                  </label>
                );
              })}
            </span>
          ) : (
            <input
              type={f.kind === "number" ? "number" : "text"}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <button type="submit" className={className} disabled={busy}>
        {submit}
      </button>
      {msg && (
        <p className="auth-copy" role="status">
          {msg}
        </p>
      )}
    </form>
  );
}
