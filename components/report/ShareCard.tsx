"use client";

// "Share this report" — idea 51, on the owner's /report. Makes a read-only
// link to THIS report for a partner, an accountant or an investor; lists
// every link made, with when it was made, when it expires and when it was
// last opened; and revokes one at a click. The link is shown once, when it
// is made — only its hash is kept, so it can't be shown again.

import { useCallback, useEffect, useState } from "react";
import { SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { fmtDate } from "./figures";

interface Share {
  id: string;
  report_generated_at: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  status: "active" | "expired" | "revoked";
}

const STATUS_WORD: Record<Share["status"], string> = {
  active: "Open",
  expired: "Expired",
  revoked: "Revoked",
};

async function errorOf(res: Response): Promise<string> {
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? "something went wrong — try again";
}

export function ShareCard() {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/report/share");
    if (res.status === 401) {
      setSignedOut(true);
      return;
    }
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setShares(((await res.json()) as { shares: Share[] }).shares);
  }, []);

  useEffect(() => {
    void load().catch(() => setError("I couldn't reach the server — try again."));
  }, [load]);

  const post = useCallback(async (body: Record<string, unknown>): Promise<Response | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/report/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return null;
      }
      return res;
    } catch {
      setError("I couldn't reach the server — try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const create = async () => {
    const res = await post({ action: "create", days });
    if (!res) return;
    setMade(((await res.json()) as { url: string }).url);
    setCopied(false);
    await load();
  };

  const revoke = async (id: string) => {
    if (!(await post({ action: "revoke", share_id: id }))) return;
    await load();
  };

  const copy = async () => {
    if (made === null) return;
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <SheetCard
      id="rq-share"
      className="rq-card noprint"
      label="Share this report"
      title="A read-only link for a partner, an accountant or an investor."
    >
      {signedOut ? (
        <p className="rq-prose">
          Sign in to share your report — a link that leaves SYB is yours to make, so it needs you
          signed in.
        </p>
      ) : (
        <>
          <p className="rq-prose">
            The link shows this report as it is now, without your answers to the recommendations and
            without anything that leads into your account. It never changes after it is made, and
            you can revoke it here at any time.
          </p>
          <div className="rq-share-row">
            <label className="rq-label" htmlFor="rq-share-days">
              Lasts
            </label>
            <select
              id="rq-share-days"
              className="rq-share-select"
              value={days}
              onChange={(e) => setDays(e.target.value === "30" ? 30 : 7)}
              disabled={busy}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
            <button type="button" className="act" onClick={() => void create()} disabled={busy}>
              Make a link <span aria-hidden="true">→</span>
            </button>
          </div>

          {made !== null && (
            <div className="rq-share-row" role="status">
              <input
                className="rq-share-url"
                readOnly
                value={made}
                aria-label="The new link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="act" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
              <p className="rq-prose">
                This is the only time the link is shown. Anyone who has it can read the report until
                it expires or you revoke it.
              </p>
            </div>
          )}

          {error !== null && (
            <p className="rq-alert" role="alert">
              {error}
            </p>
          )}

          {shares !== null && shares.length > 0 && (
            <ul className="rq-share-list" aria-label="Links you have made">
              {shares.map((s) => (
                <li key={s.id} className={`rq-share-item${s.status === "active" ? "" : " off"}`}>
                  <span>
                    <b>{STATUS_WORD[s.status]}</b> · made {fmtDate(s.created_at)} ·{" "}
                    {s.status === "revoked" && s.revoked_at !== null
                      ? `revoked ${fmtDate(s.revoked_at)}`
                      : `${s.status === "expired" ? "expired" : "expires"} ${fmtDate(s.expires_at)}`}{" "}
                    ·{" "}
                    {s.last_viewed_at === null
                      ? "not opened yet"
                      : `last opened ${fmtDate(s.last_viewed_at)} (${num(s.view_count)} view${s.view_count === 1 ? "" : "s"})`}{" "}
                    · report of {fmtDate(s.report_generated_at)}
                  </span>
                  {s.status === "active" && (
                    <button
                      type="button"
                      className="act"
                      onClick={() => void revoke(s.id)}
                      disabled={busy}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SheetCard>
  );
}
