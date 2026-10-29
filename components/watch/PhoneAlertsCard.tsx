"use client";

// Phone alerts — idea 53 (I-53.2), beside the weekly email on /watch.
//
// Switching on asks the browser for permission from the tap itself (Apple:
// call the subscribe method immediately from the gesture's handler; MDN:
// requestPermission only while handling a gesture), so the service worker
// is registered when the card loads and the tap does nothing before it
// asks. On an iPhone, web push reaches only a Home Screen web app (iOS
// 16.4 or later), so in a Safari tab the card says to add SYB first.
//
// The card never shows an endpoint or a key (the API never returns one):
// a device is its label and two dates.

import { useCallback, useEffect, useState } from "react";
import { SheetCard } from "../sheet/PageHead";

interface Device {
  id: string;
  label: string;
  created_at: string;
  last_sent_at: string | null;
  this_browser: boolean;
}
interface PushView {
  signed_in: boolean;
  configured: boolean;
  public_key: string | null;
  devices: Device[];
}
type Where = "checking" | "ok" | "iphone_tab" | "unsupported" | "denied";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayText(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

function whereAmI(): Where {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.userAgent.includes("Macintosh") && nav.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  if (ios && !standalone) return "iphone_tab";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "denied" : "ok";
}

export function PhoneAlertsCard() {
  const [view, setView] = useState<PushView | null>(null);
  const [where, setWhere] = useState<Where>("checking");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/push");
      setView(res.ok ? ((await res.json()) as PushView) : null);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load();
    setWhere(whereAmI());
  }, [load]);

  // Registered ahead of the tap, so the tap's first await is the permission prompt.
  useEffect(() => {
    if (where === "ok" && view?.configured) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
  }, [where, view?.configured]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, json };
  };

  const switchOn = async () => {
    if (!view?.public_key) return;
    setNote(null);
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setWhere(permission === "denied" ? "denied" : "ok");
      setNote("Nothing switched on: the browser didn't give permission.");
      return;
    }
    setBusy(true);
    try {
      const key = keyBytes(view.public_key);
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // A subscription made under an earlier key can't take this server's alerts.
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const { ok, json } = await post({
        action: "subscribe",
        subscription: sub.toJSON(),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setNote(
        ok
          ? "On. This device gets a few words when something new waits for your yes."
          : `Not switched on: ${String(json.error ?? "something went wrong on our side")}.`,
      );
    } catch {
      setNote("Not switched on: this browser refused the subscription. Try again in a moment.");
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (d: Device) => {
    setBusy(true);
    setNote(null);
    const { ok, json } = await post({ action: "remove", id: d.id });
    if (ok && d.this_browser && "serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    }
    setNote(
      ok ? `Removed: ${d.label} gets no more alerts.` : `Not removed: ${String(json.error)}.`,
    );
    setBusy(false);
    await load();
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    const { ok, json } = await post({ action: "test" });
    const results = (json.results ?? []) as { label: string; words: string }[];
    setNote(
      ok
        ? `Test: ${results.map((r) => `${r.label}, ${r.words}`).join("; ")}.`
        : `No test sent: ${String(json.error ?? "something went wrong on our side")}.`,
    );
    setBusy(false);
    await load();
  };

  if (!view) return null;
  const mine = view.devices.some((d) => d.this_browser);
  const status = !view.signed_in
    ? "Sign in on this device to switch alerts on."
    : !view.configured
      ? "This server can't send phone alerts yet: its keys aren't set."
      : where === "iphone_tab"
        ? "Add SYB to your Home Screen first, then switch this on there. In Safari: Share, then Add to Home Screen (iOS 16.4 or later)."
        : where === "unsupported"
          ? "This browser can't take alerts. On an iPhone, add SYB to your Home Screen first, then switch this on there."
          : where === "denied"
            ? "Alerts are blocked for SYB in this browser's settings. Allow them there, then switch this on."
            : mine
              ? "On for this device."
              : null;
  const canSwitch = view.signed_in && view.configured && where === "ok" && !mine;

  return (
    <SheetCard label="Phone alerts" title="A few words when something waits">
      <p className="wt-why">
        When something new waits for your yes, your phone gets a few words: never a figure, a name
        or an address, because a lock screen is public. Tapping it opens that proposal, and you
        decide on its card, never on the alert. Nothing between 21:00 and 08:00, and at most one a
        day.
      </p>
      {status && <p className="wt-why">{status}</p>}
      {canSwitch && (
        <p className="wt-why">
          <button type="button" className="act" disabled={busy} onClick={() => void switchOn()}>
            Switch on for this device <span aria-hidden="true">→</span>
          </button>
        </p>
      )}
      {view.devices.length > 0 && (
        <ul className="wt-devices">
          {view.devices.map((d) => (
            <li key={d.id}>
              <span>
                <b>{d.label}</b>
                {d.this_browser ? " · this device" : ""} · on since {dayText(d.created_at)}
                {d.last_sent_at ? ` · last alert ${dayText(d.last_sent_at)}` : ""}
              </span>
              <button type="button" className="act" disabled={busy} onClick={() => void remove(d)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.signed_in && view.configured && view.devices.length > 0 && (
        <p className="wt-why">
          <button type="button" className="act" disabled={busy} onClick={() => void test()}>
            Send a test <span aria-hidden="true">→</span>
          </button>
        </p>
      )}
      {note && (
        <p className="wt-why" role="status">
          {note}
        </p>
      )}
    </SheetCard>
  );
}
