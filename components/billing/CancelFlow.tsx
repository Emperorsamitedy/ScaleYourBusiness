"use client";

// §8.5's cancellation flow: before a cancel, what stops accruing and the
// verified-euro counter, and Watch offered first. A cancel ends at the
// period's end.

import { useState } from "react";
import { BillingButton } from "./BillingButton";

export function CancelFlow({
  words,
}: {
  words: {
    button: string;
    stops: string;
    verified: string;
    offer: string | null;
    downgrade: string;
    confirm: string;
    keep: string;
    failed: string;
    notArmed: string;
  };
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="ghost quiet" onClick={() => setOpen(true)}>
        {words.button}
      </button>
    );
  }
  const w = { failed: words.failed, notArmed: words.notArmed };
  return (
    <div className="billing-cancel">
      <p className="auth-copy">{words.verified}</p>
      <p className="auth-copy">{words.stops}</p>
      {words.offer && (
        <p className="auth-copy">
          {words.offer}{" "}
          <BillingButton action="downgrade" label={words.downgrade} words={w} className="act" />
        </p>
      )}
      <p className="auth-copy">
        <BillingButton action="cancel" label={words.confirm} words={w} />{" "}
        <button type="button" className="ghost quiet" onClick={() => setOpen(false)}>
          {words.keep}
        </button>
      </p>
    </div>
  );
}
