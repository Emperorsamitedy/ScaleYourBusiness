// One glyph per navigation group (the owner's dashboard pass, 2026-11-17):
// six monoline marks on a 24-unit grid, drawn in the current ink so they
// read on the rail and in the dock alike. Screens inside a group carry
// none; the glyph says where you are, the word says what it is.

import type { ReactNode } from "react";

const GLYPHS: Record<string, ReactNode> = {
  today: (
    <>
      <rect x="4" y="5" width="16" height="15" />
      <path d="M4 10h16" />
      <path d="M8 13.5h3v3H8z" fill="currentColor" stroke="none" />
    </>
  ),
  approve: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M8 12.5l3 3 5.5-6.5" />
    </>
  ),
  insights: (
    <>
      <path d="M4 19h16" />
      <path d="M7.5 16v-5" />
      <path d="M12 16V7" />
      <path d="M16.5 16v-3" />
    </>
  ),
  grow: (
    <>
      <path d="M6 18L17 7" />
      <path d="M11 7h6v6" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="16.5" cy="10" r="2.5" />
      <path d="M4 19c0-3 2.2-5 5-5s5 2 5 5" />
      <path d="M15 19c0-2 1.2-3.6 3-4.2" />
    </>
  ),
  business: (
    <>
      <path d="M4 10l2-5h12l2 5" />
      <path d="M5 10v9h14v-9" />
      <path d="M10 19v-5h4v5" />
    </>
  ),
};

export function GroupGlyph({ group, size = 16 }: { group: string; size?: number }) {
  const g = GLYPHS[group];
  if (!g) return null;
  return (
    <svg
      className="nav-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {g}
    </svg>
  );
}
