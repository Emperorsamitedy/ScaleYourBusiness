// /chat — the conversation channel (step 46a + P3-36).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ChatScreen } from "../../components/chat/ChatScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("chat.meta");
  return { title: t("title") };
}

export default function ChatPage() {
  return <ChatScreen />;
}
