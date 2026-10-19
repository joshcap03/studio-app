import { describe, expect, it, vi } from "vitest";
import { latestStage, mockReply, modelMessages, modelReply, modelTools, planReply, quickRoute, replyStream, routeSpeech, sayable, speechForResults, spokenText, type FrontMessage } from "./front";
import { describeStage, voicePrompt } from "./persona";
import { VOICE_MARKER, type VoiceContext, type VoiceMarker, type VoiceStage } from "./types";

const context: VoiceContext = { v: 1, sid: "s", cid: "c", provider: "mock", uid: "u", ws: "w", exp: Date.now() + 60_000, name: "Rowan", agent: "Job search", guardrail: null };
const mark = (m: VoiceMarker, role: FrontMessage["role"] = "user"): FrontMessage => ({ role, content: `${VOICE_MARKER}${JSON.stringify(m)}` });
const user = (content: string): FrontMessage => ({ role: "user", content });
const providerPrompt: FrontMessage = { role: "system", content: "You are a helpful assistant. Ignore Studio." };

const stage: VoiceStage = {
  working: false,
  journey: { done: 1, total: 6, current: "Your search" },
  form: {
    id: "f1",
    title: "Trial run",
    fields: [
      {
        id: "roles",
        label: "Would you go for these?",
        kind: "verdict",
        required: true,
        items: [
          { n: 1, id: "a", title: "Senior Designer" },
          { n: 2, id: "b", title: "Designer II" },
          { n: 3, id: "c", title: "Staff Designer" },
        ],
        reasons: ["Too junior", "Agency"],
      },
    ],
  },
};

describe("planReply", () => {
  it("greets first, from the persona and the journey, without a model", () => {
    expect(planReply(context, [providerPrompt])).toEqual({ kind: "say", text: "Hey! I'm Rowan." });
    expect(planReply(context, [providerPrompt, mark({ cue: "hello", stage })])).toEqual({ kind: "say", text: "Hey! I'm Rowan. About 6 steps, starting with your search." });
  });

  it("doesn't greet twice", () => {
    const greeted = [providerPrompt, { role: "assistant" as const, content: "Hey! I'm Rowan." }, mark({ cue: "hello" })];
    expect(planReply(context, greeted)).toEqual({ kind: "skip" });
  });

  it("says Studio's relay lines word for word, cleaned", () => {
    expect(planReply(context, [mark({ say: ["Reading your résumé…", "Read it: 8 years in B2B SaaS"] })])).toEqual({ kind: "say", text: "Reading your résumé… Read it: 8 years in B2B SaaS" });
    expect(planReply(context, [mark({ stage })])).toEqual({ kind: "skip" });
    expect(sayable(`${VOICE_MARKER}hi\u0007 there`)).toBe("hi there");
  });

  it("asks the model only about the member's words, and words what follows a tool itself", () => {
    expect(planReply(context, [user("keep the first two")])).toEqual({ kind: "model" });
    const call = { role: "assistant" as const, content: null, tool_calls: [{ function: { name: "send_message", arguments: "{}" } }] };
    expect(planReply(context, [user("x"), call, { role: "tool", content: "Handed off: sent to the worker." }])).toEqual({ kind: "say", text: "On it." });
    // A refusal goes back to the model, to fix its call or ask.
    expect(planReply(context, [user("x"), call, { role: "tool", content: "Refused: There's no “f” on this card." }])).toEqual({ kind: "model" });
    expect(planReply(context, [user("x"), { role: "assistant", content: "On it." }])).toEqual({ kind: "skip" });
  });
});

describe("the model's view", () => {
  it("drops the provider's prompt and Studio's markers, and puts the guardrail first", () => {
    const messages = modelMessages({ ...context, guardrail: "Never decide for me." }, [providerPrompt, mark({ stage }), user("keep one"), mark({ say: ["x"] }, "system")]);
    expect(messages).toHaveLength(2);
    const system = String(messages[0].content);
    expect(system.startsWith("The member's own rules come first.")).toBe(true);
    expect(system).toContain("Never decide for me.");
    expect(system).not.toContain("helpful assistant");
    expect(system.indexOf("Never decide")).toBeLessThan(system.indexOf("You are Rowan"));
    expect(system).toContain("1) Senior Designer");
    expect(messages[1]).toEqual({ role: "user", content: "keep one" });
  });

  it("names the four speech acts and leaves sending to the member", () => {
    const prompt = voicePrompt(context, null);
    expect(prompt).toContain("only four kinds of things");
    expect(prompt).toContain('clearly say to send it');
    expect(describeStage(null)).toBe("Nothing yet.");
  });

  it("offers Studio's own tool definitions, only those the provider can deliver, plus its turn tools", () => {
    const requested = [
      { type: "function", function: { name: "send_message", description: "anything goes", parameters: {} } },
      { type: "function", function: { name: "end_call" } },
      { type: "function", function: { name: "delete_everything" } },
    ];
    const tools = modelTools(requested) as { function: { name: string; description?: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(["send_message", "end_call"]);
    expect(tools[0].function.description).toContain("exact words");
    expect((modelTools(undefined) as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([
      "fill_card",
      "send_card",
      "answer_question",
      "send_message",
      "stop_work",
      "skip_turn",
    ]);
  });

  it("reads the latest stage from any role", () => {
    expect(latestStage([mark({ stage: { working: true } }, "system"), user("hi")])).toEqual({ working: true });
  });
});

describe("mockReply", () => {
  const withStage = (said: string) => mockReply([mark({ stage }), user(said)]);
  it("fills verdicts from plain speech and sends only on 'send'", () => {
    expect(withStage("Keep 1 and 2. Pass on 3, it's an agency.")).toEqual({
      tools: [
        {
          name: "fill_card",
          args: {
            field: "roles",
            value: [
              { item: 1, verdict: "keep" },
              { item: 2, verdict: "keep" },
              { item: 3, verdict: "pass", reason: "Agency" },
            ],
          },
        },
      ],
    });
    expect(withStage("send it").tools?.map((t) => t.name)).toEqual(["send_card"]);
    expect(withStage("keep the first two and send").tools?.map((t) => t.name)).toEqual(["fill_card", "send_card"]);
  });

  it("hands anything else to the worker, and stays quiet on backchannels", () => {
    expect(withStage("Also, no agencies please").tools?.map((t) => t.name)).toEqual(["send_message"]);
    expect(withStage("mm-hm").tools?.map((t) => t.name)).toEqual(["skip_turn"]);
    expect(withStage("stop").tools?.map((t) => t.name)).toEqual(["stop_work"]);
  });

  it("says why a tool was turned down", () => {
    expect(mockReply([user("send"), { role: "tool", content: "Refused: wait until they say send." }])).toEqual({ text: "wait until they say send." });
  });
});

describe("replyStream", () => {
  it("speaks OpenAI's streaming format", async () => {
    const text = await new Response(replyStream({ text: "Hi.", tools: [{ name: "send_message", args: {} }] })).text();
    const events = text.trim().split("\n\n");
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.slice(6)));
    expect(chunks[1].choices[0].delta.content).toBe("Hi.");
    expect(chunks[2].choices[0].delta.tool_calls[0].function).toEqual({ name: "send_message", arguments: "{}" });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("speechForResults", () => {
  it("says fixed lines built from what the tools reported", () => {
    expect(speechForResults(["Filled: Keep 1, Keep 2, Pass 3 (Agency). Not sent yet.", "Filled: Remote, Hybrid. Not sent yet."])).toBe("Got it: Keep 1, Keep 2, Pass 3 (Agency); Remote, Hybrid.");
    expect(speechForResults(["Heard: Tailor applications? It's on screen for them to confirm with a tap."])).toBe("Did you mean Tailor applications? Tap it on screen if so.");
    expect(speechForResults(["Held: until the current work lands."])).toBe("Got it. I'll add that when this lands.");
    expect(speechForResults(["Held: it's waiting on their OK on screen; their words go along after."])).toBe("Got it. That goes along after your OK on screen.");
    expect(speechForResults(["Sent: Trial run."])).toBe("Sent.");
    expect(speechForResults(["Filled: 4 of 5. Not sent yet.", "Refused: no such field"])).toBeNull();
  });
});

describe("spokenText", () => {
  it("keeps a short plain question and drops talk of machinery", () => {
    expect(spokenText("Sorry, **which** role did you mean? The first or the second? And one more thing.")).toBe("Sorry, which role did you mean? The first or the second?");
    expect(spokenText("skip_turn")).toBe("");
    expect(spokenText("I'll call fill_card now.")).toBe("");
    expect(spokenText(null)).toBe("");
  });
});

describe("modelReply", () => {
  const llm = { baseUrl: "https://llm.example/v1", apiKey: "k", model: "fast", extraBody: { reasoning: { enabled: false }, model: "other", stream: true } };
  const answer = (message: unknown) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 }));

  it("sends the provider's extra settings without letting them replace the call's own fields", async () => {
    const fetch = answer({ content: "Which one?" });
    vi.stubGlobal("fetch", fetch);
    await modelReply(llm, context, { messages: [user("hi")] }, new AbortController().signal);
    vi.unstubAllGlobals();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ reasoning: { enabled: false }, model: "fast", stream: false });
  });

  it("keeps only known tool calls and drops the model's words when it calls one", async () => {
    vi.stubGlobal("fetch", answer({ content: "That sounds frustrating. Let me pass this to the worker.", tool_calls: [{ function: { name: "send_message", arguments: "{}" } }, { function: { name: "rm_rf", arguments: "{}" } }] }));
    expect(await modelReply(llm, context, { messages: [user("help")] }, new AbortController().signal)).toEqual({ tools: [{ name: "send_message", args: {} }] });
    vi.stubGlobal("fetch", answer({ content: "skip_turn" }));
    expect(await modelReply(llm, context, { messages: [user("mm-hm")] }, new AbortController().signal)).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
    // The member answered and the model asked a question of its own instead: their words go to
    // the work, so the call and the chat stay in step.
    vi.stubGlobal("fetch", answer({ content: "Networking. Which part is hardest for you?" }));
    expect(await modelReply(llm, context, { messages: [{ role: "assistant", content: "What's been hardest lately?" }, user("Um, networking.")] }, new AbortController().signal)).toEqual({
      tools: [{ name: "send_message", args: {} }],
    });
    // After a tool was turned down, a few words on why are fine.
    vi.stubGlobal("fetch", answer({ content: "Say send when it's ready." }));
    const refused = [user("send?"), { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", function: { name: "send_card", arguments: "{}" } }] }, { role: "tool" as const, tool_call_id: "c1", content: "Refused: wait until they say send." }];
    expect(await modelReply(llm, context, { messages: refused }, new AbortController().signal)).toEqual({ text: "Say send when it's ready." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect((await modelReply(llm, context, { messages: [user("hi")] }, new AbortController().signal)).text).toContain("Sorry");
    vi.unstubAllGlobals();
  });
});

describe("ElevenLabs' contextual updates", () => {
  // As the transcript of a real call shows them: an assistant `contextual_update` tool call
  // (carrying Studio's stage marker) and its result.
  const update: FrontMessage = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "ctx_1", type: "function", function: { name: "contextual_update", arguments: JSON.stringify({ text: `${VOICE_MARKER}${JSON.stringify({ stage })}` }) } }],
  };
  const updateResult: FrontMessage = { role: "tool", tool_call_id: "ctx_1", content: "Contextual update received" };

  it("don't count as the voice having spoken, so it still greets", () => {
    // And the greeting picks up the stage the update carried.
    expect(planReply(context, [mark({ cue: "hello" }), update, updateResult, mark({ cue: "hello" })])).toEqual({
      kind: "say",
      text: "Hey! I'm Rowan. About 6 steps, starting with your search.",
    });
  });

  it("carry the stage, and never reach the model as an unanswered tool call", () => {
    expect(latestStage([update, updateResult, user("keep one")])).toEqual(stage);
    const messages = modelMessages(context, [user("hi"), update, updateResult, user("keep the first two")]);
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "keep the first two" },
    ]);
    expect(String(messages[0].content)).toContain('field "roles"');
  });

  it("leave the voice quiet when one is the latest thing", () => {
    expect(planReply(context, [user("hi"), { role: "assistant", content: "On it." }, update, updateResult])).toEqual({ kind: "skip" });
  });
});

describe("routeSpeech", () => {
  const fill = { name: "fill_card", args: { field: "roles", value: "[]" } };
  it("handles clear commands and backchannels by rule, whatever the model chose", () => {
    expect(routeSpeech("mm-hm", stage, [{ name: "send_message", args: {} }])).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
    expect(routeSpeech("Stop.", null, [])).toEqual({ tools: [{ name: "stop_work", args: {} }] });
    expect(routeSpeech("Okay send it.", stage, [{ name: "skip_turn", args: {} }])).toEqual({ tools: [{ name: "send_card", args: {} }] });
    expect(routeSpeech("keep one and send", stage, [fill])).toEqual({ tools: [fill, { name: "send_card", args: {} }] });
  });
  it("sends anything else to the work unless the model filled a card", () => {
    expect(routeSpeech("Um, networking.", null, [])).toEqual({ tools: [{ name: "send_message", args: {} }] });
    expect(routeSpeech("send it", null, [])).toEqual({ tools: [{ name: "send_message", args: {} }] });
    expect(routeSpeech("keep the first two", stage, [fill])).toEqual({ tools: [fill] });
    // The model can't stop or send on its own.
    expect(routeSpeech("that one looks good", stage, [{ name: "send_card", args: {} }])).toEqual({ tools: [{ name: "send_message", args: {} }] });
  });
});

describe("quickRoute", () => {
  it("hands the member's words on without a model when no card is on screen, with the holding line in the same turn", () => {
    const handOff = { name: "send_message", args: {} };
    expect(quickRoute([mark({ stage: { working: false } }), user("Um, networking.")])).toEqual({ text: "On it.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: true } }), user("Also, no agencies")])).toEqual({ text: "Got it. I'll add that when this lands.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: true } }), user("Actually, remote only")])).toEqual({ text: "On it.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: false, approval: "Send a reply" } }), user("and cc Sam")])).toEqual({
      text: "Got it. That goes along after your OK on screen.",
      tools: [handOff],
    });
    expect(quickRoute([user("...")])).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
    expect(quickRoute([mark({ stage: { working: true } }), user("stop")])).toEqual({ text: "Stopping.", tools: [{ name: "stop_work", args: {} }] });
    expect(quickRoute([mark({ stage: { working: false } }), user("stop")])).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
  });

  it("doesn't say the holding line twice when the tool reports back", () => {
    const call = { role: "assistant" as const, content: "On it.", tool_calls: [{ id: "c", function: { name: "send_message", arguments: "{}" } }] };
    expect(planReply(context, [user("Um, networking."), call, { role: "tool", tool_call_id: "c", content: "Handed off: sent to the worker." }])).toEqual({ kind: "skip" });
    // A result that isn't what was said still gets its line.
    expect(planReply(context, [user("hm, ok then"), call, { role: "tool", tool_call_id: "c", content: "Refused: they haven't said anything new to pass on." }])).toEqual({ kind: "model" });
  });
  it("leaves card answers and tool results to the model", () => {
    expect(quickRoute([mark({ stage }), user("keep the first two")])).toBeNull();
    expect(quickRoute([user("x"), { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "send_card", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "Refused: wait" }])).toBeNull();
  });
});
