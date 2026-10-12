import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { Workspace, type InitialThread } from "@/components/workspace/workspace";
import { getAgentStatus } from "@/lib/agent";
import { getSession } from "@/lib/auth/server";
import { withLiveStatus } from "@/lib/chat/turn";
import { getStore } from "@/lib/db/store";

// One page serves "/" (new conversation) and "/c/<id>". After the first load the browser
// switches conversations in place, without a server round trip per navigation.

export const dynamic = "force-dynamic";

export default async function WorkspacePage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { slug = [] } = await params;
  let conversationId: string | null = null;
  if (slug.length > 0) {
    const id = z.uuid().safeParse(slug[1]);
    if (slug.length !== 2 || slug[0] !== "c" || !id.success) notFound();
    conversationId = id.data;
  }

  const store = getStore();
  store.ensureUser(session.userId);
  const conversations = store.listConversations(session.userId);

  let initialThread: InitialThread | null = null;
  if (conversationId) {
    const conversation = store.getConversation(session.userId, conversationId);
    initialThread = conversation
      ? { id: conversationId, status: "ready", messages: withLiveStatus(store.listMessages(conversationId), conversationId) }
      : { id: conversationId, status: "missing", messages: [] };
  }

  return <Workspace initialConversations={conversations} initialThread={initialThread} agent={getAgentStatus()} />;
}
