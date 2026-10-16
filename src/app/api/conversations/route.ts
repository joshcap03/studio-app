import { NextResponse, type NextRequest } from "next/server";
import { getAgentAdapter } from "@/lib/agent";
import { errorResponse, noStore } from "@/lib/api";
import { removeAttachmentFiles } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
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

/** Clears the caller's chat history in the active workspace. Projects and their files stay. */
export async function DELETE(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    const store = storeFor(auth.value);
    const [paths, pending] = await Promise.all([store.allAttachmentPaths(), store.pendingApprovals()]);
    const deleted = await store.deleteAllConversations();
    await removeAttachmentFiles(auth.value, paths);
    const adapter = getAgentAdapter();
    await Promise.all(
      pending
        .filter((approval) => approval.provider === adapter.id)
        .map((approval) => adapter.discard?.(approval.providerState).catch(() => undefined)),
    );
    return NextResponse.json({ deleted });
  } catch (error) {
    return errorResponse(error);
  }
}
