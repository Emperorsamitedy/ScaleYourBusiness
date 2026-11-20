"use client";

// The invite page's one button (idea 52, I-52.4). What it does depends on
// who is signed in, which the page has already worked out:
//
//   "join"     signed in as exactly the invited address — join now;
//   "sign_in"  not signed in — email a sign-in link to the invited address
//              (never another), and redeeming it joins;
//   "wrong"    signed in as someone else — sign out first; nothing joins.
//
// L-3c: its words are the "invite.actions" catalogue; the server's refusals
// stay English until L-4.

import { useState } from "react";
import { useTr } from "../sheet/useTr";

export function InviteActions({
  token,
  mode,
  email,
}: {
  token: string;
  mode: "join" | "sign_in" | "wrong";
  email: string;
}) {
  const { tr } = useTr("invite.actions");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/members/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    const json = (await res?.json().catch(() => ({}))) as {
      error?: string;
      joined?: boolean;
      redirect?: string;
      sent?: boolean;
      delivered_via?: string;
      link?: string;
    };
    setBusy(false);
    if (!res?.ok) {
      setMessage(json.error ?? tr("failed"));
      return;
    }
    if (json.joined) {
      window.location.href = json.redirect ?? "/profile";
      return;
    }
    if (json.sent) {
      setMessage(json.delivered_via === "screen" ? tr("devLink") : tr("emailed", { email }));
      if (json.link) setLink(json.link);
    }
  };

  if (mode === "wrong") {
    return (
      <button
        type="button"
        className="ax-btn ax-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
          window.location.reload();
        }}
      >
        {tr("signOut")}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="ax-btn ax-primary"
        disabled={busy}
        onClick={() => void join()}
      >
        {mode === "join" ? tr("join") : tr("emailLink", { email })}
      </button>
      {message && (
        <p className="ax-note" role="status">
          {message}
        </p>
      )}
      {link && (
        <p className="ax-note">
          <a href={link}>{tr("signInJoin")}</a>
        </p>
      )}
    </>
  );
}
