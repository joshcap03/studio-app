import { after, NextResponse, type NextRequest } from "next/server";
import { getAgentAdapter } from "@/lib/agent";
import { errorResponse, noStore } from "@/lib/api";
import { removeAttachmentFiles } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import { forgetConversations } from "@/lib/memory";
import { authorizeTenant } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams.get("q")?.slice(0, 200) ?? "";
  try {
    return NextResponse.json({ conversations: await storeFor(auth.value).listConversations(query) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Clears the caller's chat history in the active workspace, and everything the agent kept from
 * it: the facts it saved from those chats and the provider's own memory of them. Projects,
 * their files, and facts added by hand or in other agents stay.
 */
export async function DELETE(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    const store = storeFor(auth.value);
    const [paths, pending, ids] = await Promise.all([store.allAttachmentPaths(), store.pendingApprovals(), store.conversationIds()]);
    // Before the chats go, so a failure leaves them in place to clear again.
    await forgetConversations(auth.value, ids);
    const deleted = await store.deleteAllConversations();
    await removeAttachmentFiles(auth.value, paths);
    const adapter = getAgentAdapter();
    await Promise.all(
      pending
        .filter((approval) => approval.provider === adapter.id)
        .map((approval) => adapter.discard?.(approval.providerState).catch(() => undefined)),
    );
    const forget = adapter.capabilities.rewind ? adapter.forget : undefined;
    if (forget && deleted.length > 0) {
      const tenant = { workspaceId: auth.value.workspace.id, composioUserId: auth.value.composioUserId };
      after(async () => {
        for (const conversationId of deleted) {
          await forget({ tenant, conversationId }).catch((e) => console.error("[conversations] couldn't erase the agent's copy of a chat", e));
        }
      });
    }
    return NextResponse.json({ deleted: deleted.length });
  } catch (error) {
    return errorResponse(error);
  }
}
