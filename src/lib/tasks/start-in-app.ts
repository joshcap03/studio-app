// How the background worker asks the app to start one claimed run (trigger/run-task.ts), kept
// here, free of the worker's SDK, so it can be tested. The member's access token goes only to
// the app's own run route, so a redirect is never followed: fetch drops the Authorization header
// when one crosses to another origin, and the app would answer a puzzling 401.

export interface RunInApp {
  runId: string;
  taskId: string;
  workspaceId: string;
}

export interface RunOutcome {
  status: string;
  reason: string | null;
  /** For a watch's run that isn't starting yet: when to ask again (epoch ms). */
  retryAt?: number;
}

/** APP_URL answers with a redirect: the worker must be pointed at where it leads. */
export class AppRedirected extends Error {}

export async function startRunInApp(
  appUrl: string,
  run: RunInApp,
  accessToken: string,
  options: { fetch?: typeof fetch; timeoutMs: number },
): Promise<RunOutcome> {
  const base = appUrl.trim().replace(/\/+$/, "");
  const url = `${base}/api/tasks/${run.taskId}/runs/${run.runId}?workspace=${run.workspaceId}`;
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
  if (res.status === 404) return { status: "skipped", reason: "not_found" };
  if (!res.ok) throw new Error(`The app couldn't start run ${run.runId}: ${res.status}`);
  return (await res.json()) as RunOutcome;
}
