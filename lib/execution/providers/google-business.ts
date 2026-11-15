// Google Business Profile reviews — the executor that executes nothing (I-45a).
//
// The owner's consent to Google's business.manage scope is held in the
// execution registry because that scope CAN write (reply to reviews, edit
// the listing). SYB uses it only to read reviews (lib/google-business). The
// registry gives this provider no operations, and this object refuses every
// op it could be handed, so the engine has no path from an approval to a
// Google write. There is nothing to capture and nothing to undo.

import { ExecutionConnectionError } from "../verify";
import type { ExecutionProvider } from "./fixture";

const REFUSAL =
  "ScaleX never writes to Google Business Profile: this permission is used only to read reviews.";

function refuse(): never {
  throw new ExecutionConnectionError(REFUSAL, 422);
}

export const googleBusinessExecutor: ExecutionProvider = {
  id: "google_business_reviews",
  external: true,
  async preflight() {
    return { code: "refused", message: REFUSAL };
  },
  async captureUndo() {
    return refuse();
  },
  async execute() {
    return refuse();
  },
  async undo() {
    return refuse();
  },
};
