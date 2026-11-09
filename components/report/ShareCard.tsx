"use client";

// "Share this report" — idea 51, on the owner's /report. Makes a read-only
// link to THIS report for a partner, an accountant or an investor; lists
// every link made, with when it was made, when it expires and when it was
// last opened; and revokes one at a click. The link is shown once, when it
// is made — only its hash is kept, so it can't be shown again.
//
// L-3a: its words are the "report.share" catalogue, its dates the reader's.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SheetCard } from "../sheet/PageHead";
import { useAppLocale } from "../sheet/useTr";
import { fmtDate } from "./figures";
import { WhyFold } from "./WhyFold";

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

async function errorOf(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? fallback;
}

export function ShareCard() {
  const t = useTranslations("report.share");
  const locale = useAppLocale();
  const date = (iso: string) => fmtDate(iso, locale);
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
      setError(await errorOf(res, t("wrong")));
      return;
    }
    setShares(((await res.json()) as { shares: Share[] }).shares);
  }, [t]);

  useEffect(() => {
    void load().catch(() => setError(t("unreachable")));
  }, [load, t]);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<Response | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/report/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await errorOf(res, t("wrong")));
          return null;
        }
        return res;
      } catch {
        setError(t("unreachable"));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

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
    <SheetCard id="rq-share" className="rq-card noprint" label={t("label")}>
      {signedOut ? (
        <p className="rq-prose">{t("signedOut")}</p>
      ) : (
        <>
          <WhyFold>{t("lede")}</WhyFold>
          <div className="rq-share-row">
            <label className="rq-label" htmlFor="rq-share-days">
              {t("lasts")}
            </label>
            <select
              id="rq-share-days"
              className="rq-share-select"
              value={days}
              onChange={(e) => setDays(e.target.value === "30" ? 30 : 7)}
              disabled={busy}
            >
              <option value={7}>{t("days", { days: 7 })}</option>
              <option value={30}>{t("days", { days: 30 })}</option>
            </select>
            <button type="button" className="act" onClick={() => void create()} disabled={busy}>
              {t("make")} <span aria-hidden="true">→</span>
            </button>
          </div>

          {made !== null && (
            <div className="rq-share-row" role="status">
              <input
                className="rq-share-url"
                readOnly
                value={made}
                aria-label={t("newLink")}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="act" onClick={() => void copy()}>
                {copied ? t("copied") : t("copy")}
              </button>
              <p className="rq-prose">{t("onlyOnce")}</p>
            </div>
          )}

          {error !== null && (
            <p className="rq-alert" role="alert">
              {error}
            </p>
          )}

          {shares !== null && shares.length > 0 && (
            <ul className="rq-share-list" aria-label={t("listLabel")}>
              {shares.map((s) => (
                <li key={s.id} className={`rq-share-item${s.status === "active" ? "" : " off"}`}>
                  <span>
                    <b>{t(`status.${s.status}`)}</b> · {t("made", { date: date(s.created_at) })} ·{" "}
                    {s.status === "revoked" && s.revoked_at !== null
                      ? t("revokedOn", { date: date(s.revoked_at) })
                      : s.status === "expired"
                        ? t("expired", { date: date(s.expires_at) })
                        : t("expires", { date: date(s.expires_at) })}{" "}
                    ·{" "}
                    {s.last_viewed_at === null
                      ? t("notOpened")
                      : t("lastOpened", { date: date(s.last_viewed_at), count: s.view_count })}{" "}
                    · {t("reportOf", { date: date(s.report_generated_at) })}
                  </span>
                  {s.status === "active" && (
                    <button
                      type="button"
                      className="act"
                      onClick={() => void revoke(s.id)}
                      disabled={busy}
                    >
                      {t("revoke")}
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
