"use client";

// "your salon", "your gym", "your shop" — what a signed-in screen calls
// the business, from the profile's business_type answer as /api/nav reads
// it. The naming itself is lib/core/business-noun (a table, not code);
// this only fetches. Until the menu's read answers, and if it never does,
// the screen says "your business", which is true of everyone.

import { useEffect, useState } from "react";
import { businessNoun } from "../../lib/core/business-noun";

export function useBusinessNoun(): string {
  const [noun, setNoun] = useState(() => businessNoun(null));
  useEffect(() => {
    let alive = true;
    void fetch("/api/nav")
      .then((r) => (r.ok ? (r.json() as Promise<{ business_type?: unknown }>) : null))
      .then((j) => {
        if (alive && j) setNoun(businessNoun(j.business_type));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return noun;
}
