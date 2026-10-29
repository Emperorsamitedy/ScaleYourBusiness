// /privacy — a placeholder until SYB supplies the privacy notice, with the
// facts that already hold about how the product handles data.

import type { Metadata } from "next";
import { LegalPlaceholder } from "../../components/auth/LegalPlaceholder";

export const metadata: Metadata = { title: "Privacy notice — SYB" };

export default function PrivacyPage() {
  return (
    <LegalPlaceholder
      label="Privacy"
      title="Privacy notice"
      facts={
        <>
          <h2 className="au-sheet-label">Speaking an answer</h2>
          <p>
            When you press Speak, your browser turns your speech into text. Where the browser can do
            that on your device, the audio stays on it. Otherwise your browser&rsquo;s maker does
            it: in Chrome, Google. SYB never receives the audio and stores none. Only the words you
            choose to record, ask or send are saved, exactly as if you had typed them, and nothing
            is recorded by speaking alone.
          </p>
        </>
      }
    />
  );
}
