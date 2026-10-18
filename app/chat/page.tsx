// /chat — the conversation channel (step 46a + P3-36).

import type { Metadata } from "next";
import { ChatScreen } from "../../components/chat/ChatScreen";

export const metadata: Metadata = { title: "Ask me anything — Ledgerline" };

export default function ChatPage() {
  return <ChatScreen />;
}
