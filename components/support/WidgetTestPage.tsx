"use client";

// A plain page pretending to be the owner's website, with the real
// widget script injected exactly as the snippet would — same script,
// same public endpoint, same site key. What the owner sees here is what
// a stranger sees on their site.

import { useEffect, useState } from "react";
import Link from "next/link";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "disabled" }
  | { phase: "ready"; business_name: string; site_key: string };

export function WidgetTestPage() {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/support");
      if (res.status === 401) return setState({ phase: "signedout" });
      const j = (await res.json()) as {
        settings: { site_key: string; business_name: string } | null;
      };
      if (!j.settings) return setState({ phase: "disabled" });
      setState({
        phase: "ready",
        business_name: j.settings.business_name,
        site_key: j.settings.site_key,
      });
    })();
  }, []);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const script = document.createElement("script");
    script.src = "/support-widget.js";
    script.async = true;
    script.setAttribute("data-site-key", state.site_key);
    document.body.appendChild(script);
    return () => {
      script.remove();
      document.querySelectorAll(".syb-sw, .syb-sw-launch").forEach((el) => el.remove());
    };
  }, [state]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Setting up the test page…</p>
      </main>
    );
  }
  if (state.phase === "signedout" || state.phase === "disabled") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <section className="card auth-card">
            <span className="auth-eyebrow">widget test page</span>
            <h1 className="auth-title">
              {state.phase === "signedout"
                ? "Start with the intake."
                : "Enable the assistant first."}
            </h1>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/support">
              Go to support
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">{state.business_name}</span>
        <span className="ops-meta">a pretend customer page · the widget is bottom right</span>
      </header>
      <section className="card ops-card">
        <span className="auth-eyebrow">what a visitor sees</span>
        <p className="auth-copy">
          This page stands in for your website. The button in the corner is the real widget, loaded
          by the same script and talking to the same public endpoint a customer would use. Ask it
          something you have approved, something you have not, and then ask for a person — each
          should behave as promised on the <Link href="/support">support screen</Link>.
        </p>
      </section>
    </main>
  );
}
