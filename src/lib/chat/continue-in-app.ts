import { AppRedirected } from "@/lib/tasks/start-in-app";

// How the background worker asks the app to carry on a chat reply's job (trigger/continue-chat.ts),
// kept here, free of the worker's SDK, so it can be tested. Like a task's run, the member's access
// token goes only to the app's own route, and a redirect is never followed.

export interface KeptReply {
  conversationId: string;
  replyId: string;
  workspaceId: string;
}

export interface KeptOutcome {
  /** "carried_on": the next reply ran and ended; "taken": nothing to do (carried on already, ended, or gone). */
  status: "carried_on" | "taken" | "refused";
  /** The next reply's status, when it ran. */
  reply?: string;
  /** Whether the next reply carries the job on again (the app hands that one over itself). */
  keepGoing?: boolean;
  reason?: string;
}

export async function continueChatInApp(
  appUrl: string,
  kept: KeptReply,
  accessToken: string,
  options: { fetch?: typeof fetch; timeoutMs: number },
): Promise<KeptOutcome> {
  const base = appUrl.trim().replace(/\/+$/, "");
  const url = `${base}/api/conversations/${kept.conversationId}/keep-going?workspace=${kept.workspaceId}&reply=${kept.replyId}`;
  const res = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    const where = to ? new URL(to, url).origin : "another address";
    throw new AppRedirected(`APP_URL (${new URL(base).origin}) redirects to ${where}; set APP_URL to the app's own address.`);
  }
  if (res.status === 404) return { status: "taken", reason: "not_found" };
  if (!res.ok) throw new Error(`The app couldn't carry on reply ${kept.replyId}: ${res.status}`);
  return (await res.json()) as KeptOutcome;
}
