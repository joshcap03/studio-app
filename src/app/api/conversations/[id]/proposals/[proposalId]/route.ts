import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { addMemory } from "@/lib/workspace";

type Context = { params: Promise<{ id: string; proposalId: string }> };

const body = z.object({
  decision: z.enum(["save", "dismiss"]),
  scope: z.enum(["workspace", "personal"]).optional(),
});

/**
 * Saves or dismisses a memory the agent suggested in one of the caller's replies. What gets
 * saved is the stored suggestion, not text from the request.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid(), proposalId: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Suggestion not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const store = storeFor(auth.value);
    const messages = await store.listMessages(ids.data.id);
    const message = messages.find((m) => m.memoryProposals?.some((p) => p.id === ids.data.proposalId));
    const proposal = message?.memoryProposals?.find((p) => p.id === ids.data.proposalId);
    if (!message || !proposal) return jsonError(404, "Suggestion not found.");
    if (proposal.status !== "pending") return jsonError(409, "This suggestion was already answered.");

    const scope = input.scope ?? proposal.scope;
    const memory = input.decision === "save" ? await addMemory(auth.value, proposal.content, scope) : null;
    const updated = { ...proposal, scope, status: input.decision === "save" ? ("saved" as const) : ("dismissed" as const) };
    await store.updateMessage(message.id, {
      memoryProposals: (message.memoryProposals ?? []).map((p) => (p.id === proposal.id ? updated : p)),
    });
    return NextResponse.json({ proposal: updated, memory });
  } catch (error) {
    return errorResponse(error);
  }
}
