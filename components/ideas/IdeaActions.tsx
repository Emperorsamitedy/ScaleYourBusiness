"use client";

// TASKS-IDEAS part 2's three actions: keep a check as an idea business
// (I-10), record what its test showed (I-32), and launch it (I-50). Each
// posts to its own route and says what happened in plain words.

import Link from "next/link";
import { useState } from "react";
import type { NextTest } from "../../lib/ideas/check";
import { toMinor } from "../../lib/ideas/units";
import { useTr } from "../sheet/useTr";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** I-10: keep this check. Signed out, it says to sign in and come back. */
export function KeepIdea({ token }: { token: string }) {
  const { tr, locale } = useTr("ideas");
  const [state, setState] = useState<"idle" | "busy" | "signIn" | "kept" | "failed">("idle");
  if (state === "signIn") {
    return (
      <p className="auth-copy">
        {tr("keep.signInBack")}{" "}
        <Link href={`/login?next=${encodeURIComponent(`/i/${token}`)}`}>
          {tr("keep.signInLink")}
        </Link>
      </p>
    );
  }
  if (state === "kept") return <p className="auth-copy">{tr("keep.already")}</p>;
  return (
    <div className="entry-col">
      <p className="auth-copy idea-note">{tr("keep.why")}</p>
      <button
        type="button"
        className="act"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const res = await post("/api/idea/keep", { token, locale });
            if (res.status === 401) return setState("signIn");
            if (res.status === 409) return setState("kept");
            if (!res.ok) return setState("failed");
            const { href } = (await res.json()) as { href: string };
            window.location.href = href;
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "busy" ? tr("working") : tr("keep.button")}
      </button>
      {state === "failed" && (
        <p className="auth-copy" role="alert">
          {tr("failed")}
        </p>
      )}
    </div>
  );
}

/** I-32: what the test showed, read against its lines as soon as it's recorded. */
export function RecordResult({ test, currency }: { test: NextTest; currency: string }) {
  const { tr } = useTr("ideas");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label =
    test.id === "quotes"
      ? tr("record.quotes", { currency })
      : tr(test.id === "presale" ? "record.presale" : "record.pilots");
  return (
    <form
      className="entry-col"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const whole = Number.parseInt(value, 10);
          // Quotes are typed in whole units of the plan's currency; the route takes minor units.
          const observed = test.id === "quotes" ? toMinor(whole, currency) : whole;
          const res = await post("/api/idea/result", { observed });
          if (!res.ok) return setError(tr("failed"));
          window.location.reload();
        } catch {
          setError(tr("failed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="entry-q">
        <span>{label}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="act" disabled={busy}>
        {busy ? tr("working") : tr("record.submit")}
      </button>
      {error && (
        <p className="auth-copy" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** I-50: launch. Asks once more, because it can't be undone. */
export function LaunchIdea() {
  const { tr } = useTr("ideas");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="entry-col">
      {!sure ? (
        <button type="button" className="act" onClick={() => setSure(true)}>
          {tr("launch.button")}
        </button>
      ) : (
        <>
          <p className="auth-copy">{tr("launch.sure")}</p>
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await post("/api/idea/launch", {});
                if (!res.ok) return setError(tr("failed"));
                window.location.reload();
              } catch {
                setError(tr("failed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? tr("working") : tr("launch.confirm")}
          </button>
          <button type="button" className="ghost" onClick={() => setSure(false)}>
            {tr("launch.notYet")}
          </button>
        </>
      )}
      {error && (
        <p className="auth-copy" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Gap 5: make the idea's test page from one line about the offer. */
export function MakeTestPage() {
  const { tr } = useTr("ideas");
  const [pitch, setPitch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="entry-col"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await post("/api/idea/testpage", { pitch });
          if (res.status === 422) return setError(tr("testPage.pitchRule"));
          if (!res.ok) return setError(tr("failed"));
          window.location.reload();
        } catch {
          setError(tr("failed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="entry-q">
        <span>{tr("testPage.pitchLabel")}</span>
        <input
          type="text"
          maxLength={120}
          value={pitch}
          onChange={(e) => setPitch(e.target.value)}
          placeholder={tr("testPage.pitchHint")}
          required
        />
      </label>
      <button type="submit" className="act" disabled={busy}>
        {busy ? tr("working") : tr("testPage.make")}
      </button>
      {error && (
        <p className="auth-copy" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
