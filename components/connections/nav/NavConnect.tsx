"use client";

// The NAV technical user's form (the multi-market spec §E.4, §E.5): proven
// with NAV the moment it's sent, the business's own registered name shown
// back, and one tap to revoke. Nothing typed here is kept in the browser.

import { useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "connected"; name: string | null }
  | { kind: "revoked"; message: string }
  | { kind: "error"; message: string };

export function NavConnect({ hu }: { hu: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const t = (huText: string, en: string) => (hu ? huText : en);

  async function connect(form: HTMLFormElement) {
    setState({ kind: "sending" });
    const data = new FormData(form);
    const body = Object.fromEntries(
      ["tax_number", "login", "password", "signature_key"].map((k) => [
        k,
        String(data.get(k) ?? ""),
      ]),
    );
    form.reset();
    const res = await fetch("/api/connections/nav", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      taxpayer_name?: string | null;
      error?: string;
      error_hu?: string;
    };
    if (res.ok) setState({ kind: "connected", name: json.taxpayer_name ?? null });
    else
      setState({
        kind: "error",
        message:
          (hu ? json.error_hu : json.error) ?? t("Valami hiba történt.", "Something went wrong."),
      });
  }

  async function revoke() {
    const res = await fetch("/api/connections/nav", { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as {
      message_hu?: string;
      message_en?: string;
    };
    setState({ kind: "revoked", message: (hu ? json.message_hu : json.message_en) ?? "" });
  }

  if (state.kind === "connected") {
    return (
      <div role="status">
        <p className="auth-copy">
          {t(
            "Kapcsolódva. A NAV szerint ez a vállalkozás:",
            "Connected. NAV knows this business as:",
          )}{" "}
          <b>{state.name ?? t("(név nélkül)", "(no name given)")}</b>
        </p>
        <button type="button" className="next" onClick={revoke}>
          {t("Kapcsolat megszüntetése", "Disconnect")}
        </button>
      </div>
    );
  }
  if (state.kind === "revoked") {
    return (
      <p className="auth-copy" role="status">
        {state.message}
      </p>
    );
  }
  return (
    <form
      className="ops-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void connect(e.currentTarget);
      }}
    >
      <label className="auth-copy">
        {t("Adószám", "Tax number")} <input name="tax_number" required inputMode="numeric" />
      </label>
      <label className="auth-copy">
        {t("Technikai felhasználónév", "Technical user login")} <input name="login" required />
      </label>
      <label className="auth-copy">
        {t("Jelszó", "Password")} <input name="password" type="password" required />
      </label>
      <label className="auth-copy">
        {t("Aláírókulcs", "Signature key")} <input name="signature_key" type="password" required />
      </label>
      <p className="auth-copy">
        {t(
          "A cserekulcsra nincs szükség — a SYB soha nem kéri.",
          "The exchange key isn't needed — SYB never asks for it.",
        )}
      </p>
      {state.kind === "error" && (
        <p className="auth-copy" role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" className="next" disabled={state.kind === "sending"}>
        {state.kind === "sending"
          ? t("Ellenőrzés a NAV-nál…", "Checking with NAV…")
          : t("Kapcsolódás", "Connect")}
      </button>
    </form>
  );
}
