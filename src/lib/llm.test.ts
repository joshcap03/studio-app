import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatCompletion, completeJson, jsonIn } from "./llm";

// Studio's own small model call: one request, a checked JSON answer, and nothing thrown at callers.

const llm = { baseUrl: "https://model.example.test/v1", apiKey: "k", model: "small", extraBody: { reasoning: { enabled: false }, model: "ignored" } };

function reply(content: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("chatCompletion", () => {
  it("posts one non-streaming request, with the provider's extras under the call's own fields", async () => {
    const fetchMock = reply("hi");
    vi.stubGlobal("fetch", fetchMock);
    const out = await chatCompletion(llm, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(out.content).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://model.example.test/v1/chat/completions");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "small", stream: false, max_tokens: 5, reasoning: { enabled: false } });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("throws on a bad status", async () => {
    vi.stubGlobal("fetch", reply("", 500));
    await expect(chatCompletion(llm, { messages: [], max_tokens: 5 })).rejects.toMatchObject({ status: 500 });
  });
});

describe("completeJson", () => {
  const schema = z.object({ agent: z.coerce.number().int().min(1).max(2), sure: z.boolean().default(false) });

  it("reads JSON out of fences and chatter", async () => {
    vi.stubGlobal("fetch", reply('Sure thing:\n```json\n{"agent": "2", "sure": true}\n```'));
    expect(await completeJson(llm, { system: "s", user: "u", schema })).toEqual({ agent: 2, sure: true });
  });

  it("is null on a shape the schema refuses, no JSON, or a failed call", async () => {
    vi.stubGlobal("fetch", reply('{"agent": 3}'));
    expect(await completeJson(llm, { system: "s", user: "u", schema })).toBeNull();
    vi.stubGlobal("fetch", reply("no idea"));
    expect(await completeJson(llm, { system: "s", user: "u", schema })).toBeNull();
    vi.stubGlobal("fetch", reply("", 429));
    expect(await completeJson(llm, { system: "s", user: "u", schema })).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    expect(await completeJson(llm, { system: "s", user: "u", schema })).toBeNull();
  });
});

describe("jsonIn", () => {
  it("takes the first object and nothing that isn't text", () => {
    expect(jsonIn('{"a":1} trailing')).toEqual({ a: 1 });
    expect(jsonIn(["not", "text"])).toBeNull();
    expect(jsonIn("{broken")).toBeNull();
  });
});
