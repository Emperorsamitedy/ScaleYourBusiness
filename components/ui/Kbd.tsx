// A key, as the shortcuts list and the palette's foot print it.

import type { ReactNode } from "react";
import "../../app/ui.css";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
