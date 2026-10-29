"use client";

// The invite page's one button (idea 52, I-52.4). What it does depends on
// who is signed in, which the page has already worked out:
//
//   "join"     signed in as exactly the invited address — join now;
//   "sign_in"  not signed in — email a sign-in link to the invited address
//              (never another), and redeeming it joins;
//   "wrong"    signed in as someone else — sign out first; nothing joins.

import { useState } from "react";

export function InviteActions({
  token,
  mode,
  email,
}: {
  token: string;
  mode: "join" | "sign_in" | "wrong";
  email: string;
}) {
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
      setMessage(json.error ?? "That didn't work. Try again in a minute.");
      return;
    }
    if (json.joined) {
      window.location.href = json.redirect ?? "/profile";
      return;
    }
    if (json.sent) {
      setMessage(
        json.delivered_via === "screen"
          ? "Email isn't set up here (development), so here's the sign-in link:"
          : `I've emailed a sign-in link to ${email}. Open it there and you'll join.`,
      );
      if (json.link) setLink(json.link);
    }
  };

  if (mode === "wrong") {
    return (
      <>
        <button
          type="button"
          className="au-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
            window.location.reload();
          }}
        >
          <span>Sign out</span>
          <span className="au-arrow" aria-hidden="true">
            &rarr;
          </span>
        </button>
        <p className="au-note">Then this page asks again, as {email}.</p>
      </>
    );
  }

  return (
    <>
      <button type="button" className="au-primary" disabled={busy} onClick={() => void join()}>
        <span>{mode === "join" ? "Join" : `Email a sign-in link to ${email}`}</span>
        <span className="au-arrow" aria-hidden="true">
          &rarr;
        </span>
      </button>
      {message && (
        <p className="au-note" role="status">
          {message}
        </p>
      )}
      {link && (
        <p className="au-note">
          <a href={link}>Sign in and join</a>
        </p>
      )}
    </>
  );
}
