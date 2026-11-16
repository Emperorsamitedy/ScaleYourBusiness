"use client";

// Gap 5: the test page's one button. Says thanks once pressed; nothing else.

import { useState } from "react";
import { useTr } from "../sheet/useTr";

export function InterestButton({ slug }: { slug: string }) {
  const { tr } = useTr("ideas");
  const [done, setDone] = useState(false);
  if (done) return <p className="auth-copy">{tr("testPage.thanks")}</p>;
  return (
    <button
      type="button"
      className="act"
      onClick={async () => {
        try {
          await fetch("/api/idea/interest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug }),
          });
        } finally {
          setDone(true);
        }
      }}
    >
      {tr("testPage.buy")}
    </button>
  );
}
