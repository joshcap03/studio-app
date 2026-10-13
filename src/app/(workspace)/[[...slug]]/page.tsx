import { notFound } from "next/navigation";
import { z } from "zod";
import { Workspace, type InitialThread } from "@/components/workspace/workspace";
import { getAgentStatus } from "@/lib/agent";
import { storeFor } from "@/lib/chat/store-for";
import { listSkills } from "@/lib/skills";
import { requirePageTenant } from "@/lib/tenant";

// One page serves "/" (new conversation) and "/c/<id>". After the first load the browser
// switches conversations in place, without a server round trip per navigation.

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ skill?: string | string[] }>;
}) {
  const tenant = await requirePageTenant();

  const { slug = [] } = await params;
  let conversationId: string | null = null;
  if (slug.length > 0) {
    const id = z.uuid().safeParse(slug[1]);
    if (slug.length !== 2 || slug[0] !== "c" || !id.success) notFound();
    conversationId = id.data;
  }

  const store = storeFor(tenant);
  const [conversations, conversation, skills] = await Promise.all([
    store.listConversations(),
    conversationId ? store.getConversation(conversationId) : null,
    listSkills(tenant),
  ]);
  const requested = (await searchParams).skill;
  const initialSkillId = skills.find((s) => s.id === requested)?.id ?? null;

  let initialThread: InitialThread | null = null;
  if (conversationId) {
    initialThread = conversation
      ? { id: conversationId, status: "ready", messages: await store.listMessages(conversationId) }
      : { id: conversationId, status: "missing", messages: [] };
  }

  return (
    <Workspace
      initialConversations={conversations}
      initialThread={initialThread}
      agent={getAgentStatus(tenant.workspace.id)}
      workspace={tenant.workspace}
      workspaces={tenant.workspaces}
      email={tenant.email}
      skills={skills}
      initialSkillId={initialSkillId}
    />
  );
}
