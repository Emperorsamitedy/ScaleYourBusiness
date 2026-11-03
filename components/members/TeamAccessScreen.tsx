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
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "teamAccess"
// catalogue, role names `common.roles`; dates in the reader's locale. The
// server's refusals and error sentences stay English until L-4; email
// addresses are shown as they are.

import "../../app/team-access.css";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { Role } from "../../lib/auth/role-actions";
import { ROLES, refusalFor } from "../../lib/auth/role-actions";
import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";

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

/** What each role may do, in plain words — the same three the server enforces (English; the catalogue's `teamAccess.roleMeans`). */
export const ROLE_MEANS: Record<Role, string> = {
  owner: "Everything, including connections, write access, billing and the team.",
  manager:
    "Approves and declines proposals, drafts content, answers support and can press stop. Can't connect accounts or change the team.",
  viewer: "Reads everything and can press stop. Changes nothing.",
};

/** How long an invite works — lib/auth/members INVITE_TTL_DAYS, which is server code. */
export const INVITE_DAYS = 7;

/** "6 Nov 2026", in the reader's language outside English. */
export function day(iso: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonthYear(iso.slice(0, 10), locale);
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
  const { tr, locale } = useTr("teamAccess");
  const roleWord = useTranslations("common.roles");
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
      setNotice(typeof json.error === "string" ? json.error : tr("failedTry"));
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
        <p className="ta-wait">{tr("loading")}</p>
      </main>
    );
  }
  if (state === "signed_out") {
    return (
      <main className="screen ta-screen">
        <PageHead kicker={tr("kicker")} title={tr("signedOut.title")} />
        <p className="ta-copy">{tr("signedOut.body")}</p>
      </main>
    );
  }
  if (state === "error" || view === null) {
    return (
      <main className="screen ta-screen">
        <p className="ta-wait">{tr("failed")}</p>
      </main>
    );
  }

  const mayManage = view.can["team.manage"] === true;
  const owners = view.members.filter((m) => m.role === "owner").length;
  const count = view.members.length;
  const title = tr("title", { count });

  return (
    <main className="screen ta-screen">
      <PageHead
        kicker={tr("kicker")}
        title={title}
        aside={<span>{tr("youAre", { role: view.you.role })}</span>}
      />

      {notice !== null && (
        <p className="ta-banner" aria-live="polite">
          {notice}
        </p>
      )}
      {!mayManage && (
        <p className="ta-banner" role="note">
          {refusalFor("team.manage")} {tr("readOnly")}
        </p>
      )}

      <SheetCard label={tr("members.label")} title={tr("members.title")}>
        <div className="ta-table-wrap">
          <table className="rt rt-stack ta-table">
            <thead>
              <tr>
                <th scope="col">{tr("members.person")}</th>
                <th scope="col">{tr("members.role")}</th>
                <th scope="col">{tr("members.since")}</th>
                <th scope="col">
                  <span className="sr-only">{tr("members.change")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.members.map((m) => {
                const you = m.user_id === view.you.user_id;
                const lastOwner = m.role === "owner" && owners === 1;
                return (
                  <tr key={m.user_id}>
                    <th scope="row" data-label={tr("members.person")} className="ta-who">
                      {m.email}
                      {you && <span className="ta-you"> {tr("members.you")}</span>}
                    </th>
                    <td data-label={tr("members.role")}>
                      {mayManage && !lastOwner ? (
                        <select
                          aria-label={tr("members.roleFor", { email: m.email })}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void act(
                              { action: "set_role", user_id: m.user_id, role: e.target.value },
                              tr("members.nowRole", { email: m.email, role: e.target.value }),
                            )
                          }
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {roleWord(r)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        roleWord(m.role)
                      )}
                      {lastOwner && mayManage && (
                        <p className="ta-note">{tr("members.lastOwner")}</p>
                      )}
                    </td>
                    <td data-label={tr("members.since")}>{day(m.joined_at, locale)}</td>
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
                                  tr("members.removed", { email: m.email }),
                                ).then(() => setRemoving(null))
                              }
                            >
                              {tr("members.confirmRemove", { who: you ? "me" : "them" })}
                            </button>
                            <button
                              type="button"
                              className="prop-btn quiet"
                              onClick={() => setRemoving(null)}
                            >
                              {tr("members.keep")}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="prop-btn quiet"
                            disabled={busy}
                            onClick={() => setRemoving(m.user_id)}
                          >
                            {tr("members.takeOff")}
                            <span className="sr-only"> {m.email}</span>
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

      <SheetCard label={tr("invites.label")} title={tr("invites.title")}>
        {view.invites.length === 0 ? (
          <p className="ta-copy">{tr("invites.none")}</p>
        ) : (
          <ul className="ta-invites">
            {view.invites.map((i) => (
              <li key={i.id}>
                <span className="ta-who">{i.email}</span>
                <span className="ta-meta">
                  {roleWord(i.role)} ·{" "}
                  {i.status === "expired"
                    ? tr("invites.ranOut", { day: day(i.expires_at, locale) })
                    : tr("invites.worksUntil", { day: day(i.expires_at, locale) })}
                </span>
                {mayManage && (
                  <button
                    type="button"
                    className="prop-btn quiet"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        { action: "revoke_invite", invite_id: i.id },
                        tr("invites.withdrawn"),
                      )
                    }
                  >
                    {tr("invites.withdraw")}
                    <span className="sr-only">
                      {" "}
                      {tr("invites.withdrawFor", { email: i.email })}
                    </span>
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
                  setNotice(typeof json.error === "string" ? json.error : tr("failedShort"));
                  return;
                }
                const via = json.delivered_via;
                setNotice(
                  via === "resend"
                    ? tr("invites.sent", { email: email.trim(), days: INVITE_DAYS })
                    : via === "failed"
                      ? tr("invites.emailFailed")
                      : tr("invites.noEmailSend"),
                );
                if (typeof json.link === "string") setLink(json.link);
                setEmail("");
                await load();
              });
            }}
          >
            <label className="ta-field">
              <span>{tr("invites.email")}</span>
              <input
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={tr("invites.placeholder")}
              />
            </label>
            <label className="ta-field">
              <span>{tr("invites.role")}</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleWord(r)}
                  </option>
                ))}
              </select>
            </label>
            <button className="act" disabled={busy || email.trim() === ""}>
              {tr("invites.invite")} <span aria-hidden="true">→</span>
            </button>
            <p className="ta-note">{tr(`roleMeans.${role}`)}</p>
            {!view.email_configured && <p className="ta-note">{tr("invites.noEmail")}</p>}
          </form>
        )}
        {link !== null && (
          <div className="ta-link">
            <p className="ta-note">{tr("link.note", { days: INVITE_DAYS })}</p>
            <input
              readOnly
              value={link}
              aria-label={tr("link.aria")}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="prop-btn"
              onClick={() =>
                void navigator.clipboard?.writeText(link).then(() => setNotice(tr("link.copied")))
              }
            >
              {tr("link.copy")}
            </button>
          </div>
        )}
      </SheetCard>

      <SheetCard label={tr("roles.label")} title={tr("roles.title")}>
        <dl className="ta-roles">
          {ROLES.map((r) => (
            <div key={r}>
              <dt>{roleWord(r)}</dt>
              <dd>{tr(`roleMeans.${r}`)}</dd>
            </div>
          ))}
        </dl>
      </SheetCard>

      <SheetCard label={tr("another.label")} title={tr("another.title")}>
        <p className="ta-copy">{tr("another.body")}</p>
        <form method="post" action="/api/auth/business">
          <button className="act" type="submit">
            {tr("another.add")} <span aria-hidden="true">→</span>
          </button>
        </form>
      </SheetCard>
    </main>
  );
}
