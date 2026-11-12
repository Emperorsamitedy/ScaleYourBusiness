"use client";

// Copies the shadow summary's share link (the v1 spec §4.2).

import { useState } from "react";

export function ShareLink({ path, label, done }: { path: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="next"
      onClick={() => {
        void navigator.clipboard
          .writeText(new URL(path, window.location.origin).toString())
          .then(() => setCopied(true));
      }}
    >
      {copied ? done : label}
    </button>
  );
}
