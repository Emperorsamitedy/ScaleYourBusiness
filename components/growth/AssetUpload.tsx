"use client";

// Add a photo or clip with its rights record (v1 spec §10.4). Labels arrive
// translated from the server.

import { useState } from "react";

export function AssetUpload({
  words,
  releases,
}: {
  words: {
    file: string;
    description: string;
    shotBy: string;
    personAppears: string;
    release: string;
    none: string;
    add: string;
    failed: string;
  };
  releases: { id: string; person: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/growth/assets", {
        method: "POST",
        body: new FormData(e.currentTarget),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setMsg(words.failed.replace("{why}", body.error ?? String(res.status)));
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="entry-col" onSubmit={submit}>
      <label className="entry-q">
        <span>{words.file}</span>
        <input type="file" name="file" accept="image/jpeg,image/png,video/mp4" required />
      </label>
      <label className="entry-q">
        <span>{words.description}</span>
        <input type="text" name="description" required />
      </label>
      <label className="entry-q">
        <span>{words.shotBy}</span>
        <input type="text" name="shot_by" required />
      </label>
      <label>
        <input type="checkbox" name="person_appears" /> {words.personAppears}
      </label>
      <label className="entry-q">
        <span>{words.release}</span>
        <select name="identity_release_id" defaultValue="">
          <option value="">{words.none}</option>
          {releases.map((r) => (
            <option key={r.id} value={r.id}>
              {r.person}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="act" disabled={busy}>
        {words.add}
      </button>
      {msg && <p role="alert">{msg}</p>}
    </form>
  );
}
