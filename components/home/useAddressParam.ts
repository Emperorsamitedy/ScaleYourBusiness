"use client";

// One value kept in the page's address (docs/DASHBOARD-OVERHAUL.md A3, C5):
// Home's open tab (`?tab=`) and the decision opened in place (`?review=`),
// so Back closes a sheet and a link opens one. It reads the address after
// the first paint (the server's and the browser's first render agree), and
// follows Back and Forward. Writing goes through the History API, which the
// App Router follows without loading the page again.

import { useCallback, useEffect, useState } from "react";

/** Pure: an address (path, query and hash) with one query value set, or removed when null or empty. */
export function withParam(href: string, name: string, value: string | null): string {
  const url = new URL(href, "http://local");
  if (value === null || value === "") url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

export function useAddressParam(
  name: string,
): [string | null, (value: string | null, how?: "push" | "replace") => void] {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setValue(new URLSearchParams(window.location.search).get(name));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [name]);

  const set = useCallback(
    (next: string | null, how: "push" | "replace" = "replace") => {
      const { pathname, search, hash } = window.location;
      const href = withParam(`${pathname}${search}${hash}`, name, next);
      if (how === "push") window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
      setValue(next === "" ? null : next);
    },
    [name],
  );

  return [value, set];
}
