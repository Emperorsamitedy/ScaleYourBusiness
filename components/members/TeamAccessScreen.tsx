"use client";

// /settings/team — who can sign in to this business (idea 52, I-52.4).
//
// The people on the team with their role, the invites still open, and —
// for an owner — inviting by email with a role, changing a role, taking
// someone off (which signs them out everywhere) and withdrawing an
// invite. Anyone on the team can read the list; changing it is an
// owner's, and the screen says so in the server's own words.
//
// With email set up, an invite is emailed; without it, the link comes
// back here to copy, and the screen says email isn't set up. The link
// isn't a sign-in: whoever opens it still signs in as the invited address.
//
// A role says what someone may do here, nothing more (rule 28): no
// activity, no counts, nothing about how anyone works.

import "../../app/team-access.css";
import { useCallback, useEffect, useState } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { Role } from "../../lib/auth/role-actions";
import { ROLES, ROLE_WORD, refusalFor } from "../../lib/auth/role-actions";

interface Member {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  joined_at: string;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  expires_at: string;
  status: "pending" | "expired" | "accepted" | "revoked";
}

interface View {
  members: Member[];
  invites: Invite[];
  you: { user_id: string; role: Role };
  can: Record<string, boolean>;
  email_configured: boolean;
}

/** What each role may do, in plain words — the same three the server enforces. */
export const ROLE_MEANS: Record<Role, string> = {
  owner: "Everything, including connections, write access, billing and the team.",
  manager:
    "Approves and declines proposals, drafts content, answers support and can press stop. Can't connect accounts or change the team.",
  viewer: "Reads everything and can press stop. Changes nothing.",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export function TeamAccessScreen() {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signed_out" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/members");
      if (res.status === 401) return setState("signed_out");
      if (!res.ok) return setState("error");
      setView((await res.json()) as View);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    const { ok, json } = await post(body);
    setBusy(false);
    if (!ok) {
      setNotice(typeof json.error === "string" ? json.error : "That didn't work. Try again.");
      return false;
    }
    if (json.signed_out === true) {
      window.location.href = "/login";
      return true;
    }
    setNotice(done);
    await load();
    return true;
  };

  if (state === "loading") {
    return (
      <main className="screen ta-screen">
        <p className="ta-wait">Reading who&rsquo;s on the team…</p>
      </main>
    );
  }
  if (state === "signed_out") {
    return (
      <main className="screen ta-screen">
        <PageHead kicker="Your business · Team access" title="Sign up first." />
        <p className="ta-copy">
          A team starts with you: once you&rsquo;ve signed in, you can invite the people you work
          with here.
        </p>
      </main>
    );
  }
  if (state === "error" || view === null) {
    return (
      <main className="screen ta-screen">
        <p className="ta-wait">Something went wrong on our side. Refresh to try again.</p>
      </main>
    );
  }

  const mayManage = view.can["team.manage"] === true;
  const owners = view.members.filter((m) => m.role === "owner").length;
  const count = view.members.length;
  const title = count === 1 ? "Only you can sign in here." : `${count} people can sign in here.`;

  return (
    <main className="screen ta-screen">
      <PageHead
        kicker="Your business · Team access"
        title={title}
        aside={
          <span>You&rsquo;re {view.you.role === "owner" ? "an owner" : `a ${view.you.role}`}</span>
        }
      />

      {notice !== null && (
        <p className="ta-banner" aria-live="polite">
          {notice}
        </p>
      )}
      {!mayManage && (
        <p className="ta-banner" role="note">
          {refusalFor("team.manage")} You can see who&rsquo;s here.
        </p>
      )}

      <SheetCard label="The team" title="Who can sign in">
        <div className="ta-table-wrap">
          <table className="rt rt-stack ta-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Since</th>
                <th scope="col">
                  <span className="sr-only">Change</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.members.map((m) => {
                const you = m.user_id === view.you.user_id;
                const lastOwner = m.role === "owner" && owners === 1;
                return (
                  <tr key={m.user_id}>
                    <th scope="row" data-label="Person" className="ta-who">
                      {m.email}
                      {you && <span className="ta-you"> (you)</span>}
                    </th>
                    <td data-label="Role">
                      {mayManage && !lastOwner ? (
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void act(
                              { action: "set_role", user_id: m.user_id, role: e.target.value },
                              `${m.email} is now ${e.target.value === "owner" ? "an owner" : `a ${e.target.value}`}.`,
                            )
                          }
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_WORD[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ROLE_WORD[m.role]
                      )}
                      {lastOwner && mayManage && (
                        <p className="ta-note">A business always keeps one owner.</p>
                      )}
                    </td>
                    <td data-label="Since">{day(m.joined_at)}</td>
                    <td className="ta-act">
                      {mayManage &&
                        !lastOwner &&
                        (removing === m.user_id ? (
                          <span className="ta-confirm">
                            <button
                              type="button"
                              className="prop-btn"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  { action: "remove", user_id: m.user_id },
                                  `${m.email} can't sign in here any more, and was signed out.`,
                                ).then(() => setRemoving(null))
                              }
                            >
                              Yes, take {you ? "me" : "them"} off
                            </button>
                            <button
                              type="button"
                              className="prop-btn quiet"
                              onClick={() => setRemoving(null)}
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="prop-btn quiet"
                            disabled={busy}
                            onClick={() => setRemoving(m.user_id)}
                          >
                            Take off the team<span className="sr-only"> {m.email}</span>
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SheetCard>

      <SheetCard label="Invites" title="Waiting to join">
        {view.invites.length === 0 ? (
          <p className="ta-copy">No invites are waiting.</p>
        ) : (
          <ul className="ta-invites">
            {view.invites.map((i) => (
              <li key={i.id}>
                <span className="ta-who">{i.email}</span>
                <span className="ta-meta">
                  {ROLE_WORD[i.role]} ·{" "}
                  {i.status === "expired"
                    ? `ran out ${day(i.expires_at)}`
                    : `works until ${day(i.expires_at)}`}
                </span>
                {mayManage && (
                  <button
                    type="button"
                    className="prop-btn quiet"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "revoke_invite", invite_id: i.id }, "Invite withdrawn.")
                    }
                  >
                    Withdraw<span className="sr-only"> the invite for {i.email}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {mayManage && (
          <form
            className="ta-form"
            onSubmit={(e) => {
              e.preventDefault();
              setLink(null);
              setBusy(true);
              setNotice(null);
              void post({ action: "invite", email, role }).then(async ({ ok, json }) => {
                setBusy(false);
                if (!ok) {
                  setNotice(typeof json.error === "string" ? json.error : "That didn't work.");
                  return;
                }
                const via = json.delivered_via;
                setNotice(
                  via === "resend"
                    ? `I've emailed the invite to ${email.trim()}. It works once, for 7 days.`
                    : via === "failed"
                      ? "The invite email didn't go. Copy the link below and send it yourself."
                      : "Email isn't set up here, so I can't send it. Copy the link below and send it yourself.",
                );
                if (typeof json.link === "string") setLink(json.link);
                setEmail("");
                await load();
              });
            }}
          >
            <label className="ta-field">
              <span>Email</span>
              <input
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="ta-field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_WORD[r]}
                  </option>
                ))}
              </select>
            </label>
            <button className="act" disabled={busy || email.trim() === ""}>
              Invite <span aria-hidden="true">→</span>
            </button>
            <p className="ta-note">{ROLE_MEANS[role]}</p>
            {!view.email_configured && (
              <p className="ta-note">
                Email isn&rsquo;t set up here, so you&rsquo;ll get a link to copy instead.
              </p>
            )}
          </form>
        )}
        {link !== null && (
          <div className="ta-link">
            <p className="ta-note">
              The invite link. It works once, for 7 days, and only for the address you invited:
              whoever opens it still signs in as that address.
            </p>
            <input
              readOnly
              value={link}
              aria-label="Invite link"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="prop-btn"
              onClick={() =>
                void navigator.clipboard?.writeText(link).then(() => setNotice("Copied."))
              }
            >
              Copy
            </button>
          </div>
        )}
      </SheetCard>

      <SheetCard label="Roles" title="What each role can do">
        <dl className="ta-roles">
          {ROLES.map((r) => (
            <div key={r}>
              <dt>{ROLE_WORD[r]}</dt>
              <dd>{ROLE_MEANS[r]}</dd>
            </div>
          ))}
        </dl>
      </SheetCard>

      <SheetCard label="Another business" title="Run more than one business?">
        <p className="ta-copy">
          Add another business under the same email. Each one has its own interview, its own team
          and its own bill; you switch between them from the menu.
        </p>
        <form method="post" action="/api/auth/business">
          <button className="act" type="submit">
            Add another business <span aria-hidden="true">→</span>
          </button>
        </form>
      </SheetCard>
    </main>
  );
}
