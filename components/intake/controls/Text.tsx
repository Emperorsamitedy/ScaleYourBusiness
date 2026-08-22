"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function TextControl({ onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const wireOf = (raw: string): unknown => (raw.trim() === "" ? null : raw.trim());

  return (
    <input
      ref={ref}
      className="field"
      type="text"
      autoComplete="off"
      onChange={(e) => onChange({ wire: wireOf(e.target.value) })}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit({ wire: wireOf(e.currentTarget.value) });
        }
      }}
    />
  );
}
