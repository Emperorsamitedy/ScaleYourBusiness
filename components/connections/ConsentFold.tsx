"use client";

// What a permission allows, line by line (docs/DASHBOARD-OVERHAUL.md, L6: less
// to read at once). Six permissions each listed everything they allow, all the
// time, which made the part of Connections about changing things more than
// 5,000 px tall. The lines are in front of the person while they grant the
// permission (rule 13: a separate, audited consent is given knowing what it
// covers) and one press away at any other time, never removed.

import type { ReactNode } from "react";
import { Fold } from "../sheet/Fold";
import { useCn } from "./useCn";

export function ConsentFold({
  open,
  children,
}: {
  /** The permission is being granted right now: its lines are shown, not folded. */
  open: boolean;
  children: ReactNode;
}) {
  const { t } = useCn("connections.write");
  if (open) return <>{children}</>;
  return (
    <Fold summary={t("allows")} className="cn-allows">
      {children}
    </Fold>
  );
}
