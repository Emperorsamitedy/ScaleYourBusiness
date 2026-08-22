"use client";

// On-deck preview — dashed and quiet, so the owner can always see there
// is exactly one more thing coming (§4.1). Text cross-fades on advance.

export function OnDeck({ text }: { text: string }) {
  return (
    <div className="ondeck" aria-label="Next question">
      <span className="lbl">Next</span>
      <span key={text} className="ondeck-text">
        {text}
      </span>
    </div>
  );
}
