"use client";

// One tap in or out of the peer pool (§5.5): the owner's choice, recorded
// by /api/peers/consent. Nothing else on the screen changes either way —
// a business that doesn't contribute still sees every comparison.

import { useState } from "react";

export function PeerContribute({
  contributing,
  words,
}: {
  contributing: boolean;
  words: { on: string; off: string; stop: string; start: string; failed: string };
}) {
  const [on, setOn] = useState(contributing);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function flip() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/peers/consent", { method: on ? "DELETE" : "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { opted_in: boolean };
      setOn(body.opted_in);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="bm-note pp-contribute">
      {on ? words.on : words.off}{" "}
      <button type="button" className="ghost quiet" onClick={flip} disabled={busy}>
        {on ? words.stop : words.start}
      </button>
      {failed && <span role="alert"> {words.failed}</span>}
    </p>
  );
}
