import { describe, expect, it, vi } from "vitest";
import { AppRedirected, startRunInApp } from "./start-in-app";

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
};

function answering(res: Response) {
  return vi.fn<typeof fetch>(async () => res);
}

describe("startRunInApp", () => {
  it("posts the member's token to the run's route and never follows a redirect", async () => {
    const fetch = answering(Response.json({ status: "done", reason: null }));
    const outcome = await startRunInApp("https://app.example.test/", run, "token", { fetch, timeoutMs: 1000 });
    expect(outcome).toEqual({ status: "done", reason: null });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://app.example.test/api/tasks/${run.taskId}/runs/${run.runId}?workspace=${run.workspaceId}`);
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer token" }, redirect: "manual" });
  });

  it("says where APP_URL redirects instead of failing on the app's 401", async () => {
    const fetch = answering(new Response("Redirecting...", { status: 308, headers: { location: "https://new.example.test/api/tasks/x" } }));
    const started = startRunInApp("https://old.example.test", run, "token", { fetch, timeoutMs: 1000 });
    await expect(started).rejects.toBeInstanceOf(AppRedirected);
    await expect(started).rejects.toThrow("APP_URL (https://old.example.test) redirects to https://new.example.test");
  });

  it("treats a missing run as skipped and any other refusal as an error", async () => {
    await expect(startRunInApp("https://app.example.test", run, "t", { fetch: answering(new Response(null, { status: 404 })), timeoutMs: 1000 }))
      .resolves.toEqual({ status: "skipped", reason: "not_found" });
    await expect(startRunInApp("https://app.example.test", run, "t", { fetch: answering(new Response(null, { status: 401 })), timeoutMs: 1000 }))
      .rejects.toThrow(`The app couldn't start run ${run.runId}: 401`);
  });
});
