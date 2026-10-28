import { describe, expect, it, vi } from "vitest";
import { AppRedirected } from "@/lib/tasks/start-in-app";
import { continueChatInApp } from "./continue-in-app";

const kept = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  replyId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
};

function answering(res: Response) {
  return vi.fn<typeof fetch>(async () => res);
}

describe("continueChatInApp", () => {
  it("posts the member's token to the conversation's keep-going route and never follows a redirect", async () => {
    const fetch = answering(Response.json({ status: "carried_on", reply: "complete", keepGoing: false }));
    expect(await continueChatInApp("https://app.example.test/", kept, "token", { fetch, timeoutMs: 1000 })).toEqual({ status: "carried_on", reply: "complete", keepGoing: false });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://app.example.test/api/conversations/${kept.conversationId}/keep-going?workspace=${kept.workspaceId}&reply=${kept.replyId}`);
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer token" }, redirect: "manual" });
  });

  it("says where APP_URL redirects, treats a missing conversation as nothing to do, and any other refusal as an error", async () => {
    const redirect = answering(new Response(null, { status: 308, headers: { location: "https://new.example.test/x" } }));
    await expect(continueChatInApp("https://old.example.test", kept, "t", { fetch: redirect, timeoutMs: 1000 })).rejects.toBeInstanceOf(AppRedirected);
    await expect(continueChatInApp("https://app.example.test", kept, "t", { fetch: answering(new Response(null, { status: 404 })), timeoutMs: 1000 }))
      .resolves.toEqual({ status: "taken", reason: "not_found" });
    await expect(continueChatInApp("https://app.example.test", kept, "t", { fetch: answering(new Response(null, { status: 401 })), timeoutMs: 1000 }))
      .rejects.toThrow(`The app couldn't carry on reply ${kept.replyId}: 401`);
  });
});
