import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { routeAsk } from "@/lib/route";
import { authorizeTenant } from "@/lib/tenant";
import type { RouteResult } from "@/lib/types";

// Which of the member's agents takes an ask typed on Home. The answer is always one of their own
// agents that is on Home; the ask is read once here and never stored or logged. Under the mock
// agent (QA) no model is called, so the keyword fallback decides.

const body = z.object({ text: z.string().trim().min(1).max(4000) });

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const { agent, llm } = getConfig();
    let result: RouteResult = await routeAsk(auth.value, input.text, { llm: agent.provider === "mock" ? null : (llm ?? null) });
    // Never an agent that isn't theirs and on Home: the tab's own, and not sure, if anything slipped.
    if (!auth.value.workspaces.some((w) => w.id === result.workspaceId && w.onHome)) {
      result = { workspaceId: auth.value.workspace.id, sure: false, by: "last" };
    }
    return NextResponse.json(result, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
