"use client";

// A plain page pretending to be the owner's website, with the real
// widget script injected exactly as the snippet would — same script,
// same public endpoint, same site key. What the owner sees here is what
// a stranger sees on their site.
//
// L-3c: this page's own frame speaks to the owner, so it is the "support"
// catalogue (support.test) in the owner's language. The widget it loads is
// customer-facing and speaks the business's language (L-5/L-6); the
// business's name is content.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "disabled" }
  | { phase: "ready"; business_name: string; site_key: string };

export function WidgetTestPage() {
  const t = useTranslations("support.test");
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
        <p className="auth-copy">{t("loading")}</p>
      </main>
    );
  }
  if (state.phase === "signedout" || state.phase === "disabled") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <section className="card auth-card">
            <span className="auth-eyebrow">{t("eyebrow")}</span>
            <h1 className="auth-title">
              {state.phase === "signedout" ? t("signedOut") : t("disabled")}
            </h1>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/support">
              {t("goSupport")}
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
        <span className="ops-meta">{t("pretend")}</span>
      </header>
      <section className="card ops-card">
        <span className="auth-eyebrow">{t("seesLabel")}</span>
        <p className="auth-copy">
          {t.rich("body", { link: (c) => <Link href="/support">{c}</Link> })}
        </p>
      </section>
    </main>
  );
}
