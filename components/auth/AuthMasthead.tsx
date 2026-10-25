// The ink masthead every entrance screen shares: the wordmark at left,
// one mono link at right, the static cobalt rule beneath (ux-spec §2).

import Link from "next/link";
import type { ReactNode } from "react";

export function AuthMasthead({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <header className="au-mast">
      <Link href="/" className="au-mark">
        SYB
      </Link>
      {href && children ? (
        <Link href={href} className="au-mast-link">
          {children}
        </Link>
      ) : null}
    </header>
  );
}
