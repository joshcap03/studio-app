import { describe, expect, it } from "vitest";
import type { MessageFeedback } from "@/lib/types";
import { FEEDBACK_KEY, sendRating, syncRating, type LangsmithConfig } from "./langsmith";

const TRACE = "70e21f8f-0000-4000-8000-000000000001";
const REPLY = "c0ffee00-0000-4000-8000-000000000002";

function recorder(respond: (url: string, init: RequestInit) => Response = () => Response.json({})) {
  const calls: { url: string; init: RequestInit }[] = [];
  const config: LangsmithConfig = {
    apiKey: "ls-test-key",
    endpoint: "https://langsmith.example.test",
    fetch: (async (url: URL | string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }) as typeof fetch,
  };
  return { config, calls };
}

const down: MessageFeedback = { rating: "down", reasons: ["Too long", "Missed context"], note: "Skip the preamble." };

describe("sendRating", () => {
  it("puts the rating on the run's trace, keyed by the reply so rating again replaces it", async () => {
    const { config, calls } = recorder();
    await sendRating(config, TRACE, REPLY, down);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://langsmith.example.test/api/v1/feedback");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("ls-test-key");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      id: REPLY,
      run_id: TRACE,
      key: FEEDBACK_KEY,
      score: 0,
      value: "down",
      comment: "Too long, Missed context — Skip the preamble.",
      extra: { reasons: ["Too long", "Missed context"] },
      feedback_source: { type: "app" },
    });

    await sendRating(config, TRACE, REPLY, { rating: "up", reasons: [] });
    const up = JSON.parse(calls[1].init.body as string);
    expect(up).toMatchObject({ id: REPLY, score: 1, value: "up", comment: null });
  });

  it("removes the trace's feedback when the rating is cleared, even if it never got there", async () => {
    const { config, calls } = recorder(() => new Response("not found", { status: 404 }));
    await expect(sendRating(config, TRACE, REPLY, null)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: `https://langsmith.example.test/api/v1/feedback/${REPLY}`, init: { method: "DELETE" } });
  });

  it("fails loudly on an error so the caller can log it", async () => {
    const { config } = recorder(() => new Response("bad key", { status: 401 }));
    await expect(sendRating(config, TRACE, REPLY, down)).rejects.toThrow(/401/);
  });
});

describe("syncRating", () => {
  const store = (reply: { feedback: MessageFeedback | null; traceId: string | null } | null) => ({ ratedReply: async () => reply });

  it("sends the reply's current rating to its trace", async () => {
    const { config, calls } = recorder();
    await syncRating(store({ feedback: down, traceId: TRACE }), "conv", REPLY, config);
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ run_id: TRACE, value: "down" });
  });

  it("does nothing without LangSmith, a trace, or the reply", async () => {
    const { config, calls } = recorder();
    await syncRating(store({ feedback: down, traceId: null }), "conv", REPLY, config);
    await syncRating(store(null), "conv", REPLY, config);
    await syncRating(store({ feedback: down, traceId: TRACE }), "conv", REPLY, undefined);
    expect(calls).toEqual([]);
  });
});
