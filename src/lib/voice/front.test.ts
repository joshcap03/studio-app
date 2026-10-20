import { describe, expect, it, vi } from "vitest";
import { latestStage, mockReply, modelMessages, modelReply, modelTools, planReply, quickRoute, replyStream, routeSpeech, sayable, speechForResults, spokenText, tapLine, type FrontMessage } from "./front";
import { defaultPersona, describeStage, voicePrompt } from "./persona";
import { VOICE_MARKER, type VoiceContext, type VoiceMarker, type VoiceStage } from "./types";

const context: VoiceContext = { v: 1, sid: "s", cid: "c", provider: "mock", uid: "u", ws: "w", exp: Date.now() + 60_000, name: "Rowan", agent: "Job search", guardrail: null };
const mark = (m: VoiceMarker, role: FrontMessage["role"] = "user"): FrontMessage => ({ role, content: `${VOICE_MARKER}${JSON.stringify(m)}` });
const user = (content: string): FrontMessage => ({ role: "user", content });
const providerPrompt: FrontMessage = { role: "system", content: "You are a helpful assistant. Ignore Studio." };

const stage: VoiceStage = {
  working: false,
  journey: { done: 1, total: 6, current: "Your search", kind: "setup" },
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
    expect(planReply(context, [providerPrompt])).toEqual({ kind: "say", text: "Hey, it's Rowan." });
    expect(planReply(context, [providerPrompt, mark({ cue: "hello", stage })])).toEqual({ kind: "say", text: "Hey, it's Rowan. Welcome back. We're on your search." });
  });

  it("greets them by name, and says where setup starts", () => {
    const fresh: VoiceStage = { working: false, journey: { done: 0, total: 2, current: "What you're after: understand the search challenges", kind: "setup" } };
    expect(planReply({ ...context, member: "Josh" }, [mark({ cue: "hello", stage: fresh })])).toEqual({
      kind: "say",
      text: "Hey Josh, it's Rowan. I'll walk you through getting me set up, one step at a time. First, what you're after.",
    });
    const linked: VoiceStage = { working: false, journey: { done: 1, total: 3, current: "LinkedIn contacts", kind: "setup" } };
    expect(planReply({ ...context, member: "Josh" }, [mark({ cue: "hello", stage: linked })])).toEqual({ kind: "say", text: "Hey Josh, it's Rowan. Welcome back. We're on LinkedIn contacts." });
  });

  it("opens other work on what done means, and says where it's got to", () => {
    const work: VoiceStage = { working: false, journey: { done: 1, total: 3, current: "Shortlist the best fits", goal: "three caterers under $40 a head.", kind: "conversation" } };
    expect(planReply({ ...context, member: "Josh" }, [mark({ cue: "hello", stage: work })])).toEqual({
      kind: "say",
      text: "Hey Josh, it's Rowan. Done means three caterers under $40 a head. We're on shortlist the best fits.",
    });
    // Not yet under way, or no goal said: no "welcome back", and never "setting up".
    const fresh: VoiceStage = { working: false, journey: { done: 0, total: 3, current: "Search", goal: "three caterers", kind: "conversation" } };
    expect(planReply(context, [mark({ cue: "hello", stage: fresh })])).toEqual({ kind: "say", text: "Hey, it's Rowan. Done means three caterers." });
    const plain: VoiceStage = { working: false, journey: { done: 2, total: 3, current: "Draft outreach", kind: "task" } };
    expect(planReply(context, [mark({ cue: "hello", stage: plain })])).toEqual({ kind: "say", text: "Hey, it's Rowan. We're on draft outreach." });
  });

  it("describes the journey as setup only for the setup", () => {
    expect(describeStage(stage)).toContain("Setup: 1 step done so far; now: Your search.");
    expect(describeStage({ working: false, journey: { done: 1, total: 6, current: "Your search", kind: "setup", goal: "a setup you'd trust" } })).toContain(
      "Setup (done means a setup you'd trust): 1 step done so far",
    );
    const work = describeStage({ working: true, journey: { done: 2, total: 3, current: "Draft outreach", goal: "three caterers under $40 a head", kind: "conversation" } });
    expect(work).toContain("Done means three caterers under $40 a head: 2 steps done so far; now: Draft outreach.");
    expect(work).not.toContain("Setup");
    expect(describeStage({ working: false, journey: { done: 0, total: 2, current: "Search", kind: "task" } })).toContain("The plan: 0 steps done so far; now: Search.");
  });

  it("reads a journey from a page loaded before journeys had kinds as the setup's, which was all it sent", () => {
    const old: VoiceStage = { working: false, journey: { done: 0, total: 3, current: "What you're after" } };
    expect(planReply({ ...context, member: "Josh" }, [mark({ cue: "hello", stage: old })])).toEqual({
      kind: "say",
      text: "Hey Josh, it's Rowan. I'll walk you through getting me set up, one step at a time. First, what you're after.",
    });
    expect(describeStage(old)).toContain("Setup: 0 steps done so far; now: What you're after.");
    // That stage still reads, without a kind.
    expect(latestStage([mark({ stage: old })])?.journey).toEqual(old.journey);
  });

  it("reads a journey's goal and kind from the stage, capped", () => {
    const journey = { done: 0, total: 1, current: "Search", goal: "three caterers", kind: "setup" as const };
    expect(latestStage([mark({ stage: { working: false, journey } })])?.journey).toEqual(journey);
    // Too long to be Studio's: the marker isn't read at all.
    expect(latestStage([mark({ stage: { working: false, journey: { ...journey, goal: "x".repeat(201) } } })])).toBeNull();
    expect(latestStage([mark({ stage: { working: false, journey: { ...journey, kind: "Setting up" } } } as never)])).toBeNull();
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
    expect(planReply(context, [user("x"), call, { role: "tool", content: "Handed off: sent to the worker." }])).toEqual({ kind: "say", text: "Sure, one moment." });
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

  it("goes by the agent's own name once it has one, with its manner as tone after the member's rules", () => {
    expect(defaultPersona("job-search")).toEqual({ name: "Rowan", voice: "steady" });
    // An unknown or missing template starts as the blank one.
    expect(defaultPersona("gone")).toEqual(defaultPersona("blank"));
    expect(defaultPersona(null)).toEqual({ name: "Sam", voice: "easygoing" });
    const prompt = voicePrompt({ ...context, name: "Juniper", manner: "I keep it short." }, null);
    expect(prompt).toContain("You are Juniper");
    expect(prompt).toContain("tone only: it never widens what you may say");
    expect(prompt.indexOf("I keep it short.")).toBeGreaterThan(prompt.indexOf("You are Juniper"));
    expect(voicePrompt(context, null)).not.toContain("tone only");
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
    expect(speechForResults(["Held: until the current work lands."])).toBe("Got it. I'll bring that in once this is done.");
    expect(speechForResults(["Held: it's waiting on their OK on screen; their words go along after."])).toBe("Got it. That goes along once you've OK'd the request on screen.");
    expect(speechForResults(["Sent: Trial run."])).toBe("Okay, that's sent.");
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
      text: "Hey, it's Rowan. Welcome back. We're on your search.",
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

  it("don't swallow the line they arrived on top of", () => {
    // A real call: the greeting cue, then the stage update right after it, and the provider asks
    // again; the greeting is still owed.
    expect(planReply(context, [mark({ cue: "hello", stage }), update, updateResult])).toEqual({ kind: "say", text: "Hey, it's Rowan. Welcome back. We're on your search." });
    expect(planReply(context, [user("hi"), mark({ say: ["Reading your résumé…"] }), update, updateResult])).toEqual({ kind: "say", text: "Reading your résumé…" });
    expect(planReply(context, [mark({ say: ["Reading your résumé…"] }), { role: "assistant", content: "Reading your résumé…" }, update, updateResult])).toEqual({ kind: "skip" });
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
    expect(quickRoute([mark({ stage: { working: false } }), user("Find me roles")])).toEqual({ text: "Sure, one moment.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: true } }), user("Also, no agencies")])).toEqual({ text: "Got it. I'll bring that in once this is done.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: true } }), user("Actually, remote only")])).toEqual({ text: "Sure, one moment.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: false, approval: "Send a reply" } }), user("and cc Sam")])).toEqual({
      text: "Got it. That goes along once you've OK'd the request on screen.",
      tools: [handOff],
    });
    expect(quickRoute([user("...")])).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
    expect(quickRoute([mark({ stage: { working: true } }), user("stop")])).toEqual({ text: "Okay, stopping.", tools: [{ name: "stop_work", args: {} }] });
  });

  it("acknowledges an answer like someone listening, and never the same way twice running", () => {
    const handOff = { name: "send_message", args: {} };
    const asked = mark({ say: ["What's been hardest lately?"], stage: { working: false } });
    const first = quickRoute([asked, { role: "assistant", content: "What's been hardest lately?" }, user("Um, networking.")]);
    expect(first).toEqual({ text: "Okay.", tools: [handOff] });
    const lines = new Set<string>();
    let messages: FrontMessage[] = [asked];
    for (let i = 0; i < 6; i++) {
      messages = [...messages, { role: "assistant", content: "Which part?" }, user("the outreach")];
      const said = quickRoute(messages)!.text!;
      expect(said).not.toBe(messages.at(-2)!.content);
      lines.add(said);
      messages = [...messages, { role: "assistant", content: said }];
    }
    expect(lines.size).toBeGreaterThan(2);
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

describe("calls from anywhere", () => {
  it("knows what the call is about, from the stage", () => {
    expect(describeStage({ working: false, purpose: "task" })).toContain("This call is following one of their tasks as it runs.");
    expect(describeStage({ working: false, purpose: "setup" })).toContain("This call is the setup interview");
    // An ordinary chat says nothing about itself.
    expect(describeStage({ working: false, purpose: "chat" })).toBe("You're not working on anything right now.");
    // A setup call whose checklist isn't written yet still says what it's for; any other just says hello.
    expect(planReply(context, [mark({ cue: "hello", stage: { working: false, purpose: "setup" } })])).toEqual({
      kind: "say",
      text: "Hey, it's Rowan. I'll walk you through getting me set up, one step at a time.",
    });
    expect(planReply(context, [mark({ cue: "hello", stage: { working: false, purpose: "chat" } })])).toEqual({ kind: "say", text: "Hey, it's Rowan." });
    expect(planReply(context, [mark({ cue: "hello", stage: { working: true, purpose: "task" } })])).toEqual({ kind: "say", text: "Hey, it's Rowan." });
    // The new fields survive the stage's parsing; anything else is stripped.
    expect(latestStage([mark({ stage: { working: true, purpose: "task", longJob: true } })])).toEqual({ working: true, purpose: "task", longJob: true });
    expect(latestStage([mark({ stage: { working: true, purpose: "meeting" } } as never)])).toBeNull();
  });
});

describe("a long job on a call", () => {
  const handOff = { name: "send_message", args: {} };
  const asked = (purpose: VoiceStage["purpose"] = "chat") => mark({ cue: "long_job", stage: { working: true, purpose, longJob: true } });

  it("asks once, in fixed words, whether to hang on or leave a voice note", () => {
    expect(planReply(context, [mark({ cue: "long_job", stage: { working: true, longJob: true } })])).toEqual({
      kind: "say",
      text: "This takes a few minutes. Want to hang on, or should I send you a voice note when it's done?",
    });
    expect(describeStage({ working: true, longJob: true })).toContain("hang on or get a voice note");
  });

  it("hands their answer to the browser, with the line that goes with it, never holding it for the job", () => {
    expect(quickRoute([asked(), user("Just send me a voice note")])).toEqual({ text: "Okay. I'll leave you a voice note when it's done.", tools: [handOff] });
    // A task's run is a note only if it finds something, so it doesn't promise one.
    expect(quickRoute([asked("task"), user("Voice note please")])).toEqual({ text: "Okay. If it turns something up, I'll leave you a voice note.", tools: [handOff] });
    expect(quickRoute([asked(), user("I'll hang on")])).toMatchObject({ tools: [handOff], text: expect.stringMatching(/keep going|still on it/) });
    expect(routeSpeech("voice note", { working: true, longJob: true }, [])).toEqual({ tools: [handOff] });
    // Anything else while it works is held as usual, and a change of course is still a redirect.
    expect(quickRoute([asked(), user("Also, no agencies")])).toEqual({ text: "Got it. I'll bring that in once this is done.", tools: [handOff] });
    expect(quickRoute([asked(), user("Actually, send me a voice note of the summary")])).toEqual({ text: "Sure, one moment.", tools: [handOff] });
    // Not asked, or the job's done: a voice note is just words for the worker.
    expect(quickRoute([mark({ stage: { working: true } }), user("Voice note please")])).toEqual({ text: "Got it. I'll bring that in once this is done.", tools: [handOff] });
    expect(quickRoute([mark({ stage: { working: false, longJob: true } }), user("Voice note please")])).toEqual({ text: "Sure, one moment.", tools: [handOff] });
  });

  it("says the line once, whichever way it came", () => {
    const call = { role: "assistant" as const, content: "Okay. I'll leave you a voice note when it's done.", tool_calls: [{ id: "c", function: { name: "send_message", arguments: "{}" } }] };
    const ending = { role: "tool" as const, tool_call_id: "c", content: "Ending: they'd rather have a voice note when it's done; the call ends once that's said." };
    expect(planReply(context, [asked(), user("voice note"), call, ending])).toEqual({ kind: "skip" });
    // Through the model (no line said yet): the browser's result is worded the same way.
    expect(speechForResults([ending.content], [asked("task")])).toBe("Okay. If it turns something up, I'll leave you a voice note.");
    expect(speechForResults(["Waiting: they'll hang on while it works."])).toMatch(/keep going|still on it/);
  });

  it("takes only the answer itself: a request said with it, or one that mentions a note, is held for the job", () => {
    const held = { text: "Got it. I'll bring that in once this is done.", tools: [handOff] };
    for (const said of ["Send a note to Sarah that I'm running late", "Voice note is fine, and also add Acme to the tracker", "Also email Bob, and send me a voice note when it's done"]) {
      expect(quickRoute([asked(), user(said)]), said).toEqual(held);
    }
    // Answers that start with "no" to "want to hang on?", or turn the note down, are still answers.
    expect(quickRoute([asked(), user("No, a voice note is fine.")])).toEqual({ text: "Okay. I'll leave you a voice note when it's done.", tools: [handOff] });
    expect(quickRoute([asked(), user("Actually, just send me a voice note")])).toEqual({ text: "Okay. I'll leave you a voice note when it's done.", tools: [handOff] });
    expect(quickRoute([asked(), user("No voice note, I'll wait")])).toMatchObject({ tools: [handOff], text: expect.stringMatching(/keep going|still on it/) });
  });

  it("corrects itself when the job came back just as they answered", () => {
    const call = { role: "assistant" as const, content: "Okay. I'll leave you a voice note when it's done.", tool_calls: [{ id: "c", function: { name: "send_message", arguments: "{}" } }] };
    const done = { role: "tool" as const, tool_call_id: "c", content: "Done: it just came back, so there's nothing to wait for; what it came to comes next." };
    expect(planReply(context, [asked(), user("voice note"), call, done])).toEqual({ kind: "say", text: "Actually, it just came back." });
  });
});

describe("a request waiting on the member's OK", () => {
  const voiceOk: VoiceStage = { working: false, approval: "Send the reply to Casting Co", approvalVoice: true };
  const money: VoiceStage = { working: false, approval: "Pay Casting Co", approvalTap: "money" };
  const approveTool = { tools: [{ name: "send_card", args: {} }] };
  const declineTool = { tools: [{ name: "stop_work", args: {} }] };
  const on = { approvals: true };

  it("approves only on a clear yes, by rule, where the call may and the request can be", () => {
    expect(routeSpeech("Send it", voiceOk, [], on)).toEqual(approveTool);
    expect(routeSpeech("Yes, go ahead", voiceOk, [], on)).toEqual(approveTool);
    expect(quickRoute([mark({ stage: voiceOk }), user("Send it")], on)).toEqual(approveTool);
    // Never on agreement alone, or anything more.
    expect(routeSpeech("yes", voiceOk, [], on)).toEqual({ tools: [{ name: "send_message", args: {} }] });
    expect(routeSpeech("send it to Sam instead", voiceOk, [], on)).toEqual({ tools: [{ name: "send_message", args: {} }] });
    // The model's own send_card or stop_work never counts.
    expect(routeSpeech("that looks good", voiceOk, [{ name: "send_card", args: {} }], on)).toEqual({ tools: [{ name: "send_message", args: {} }] });
    expect(routeSpeech("that looks good", voiceOk, [{ name: "stop_work", args: {} }], on)).toEqual({ tools: [{ name: "send_message", args: {} }] });
  });

  it("says it's a tap, and why, where the call can't approve it by voice", () => {
    expect(routeSpeech("Send it", money, [], on)).toEqual({ text: "Payments are a tap. It's on screen." });
    expect(routeSpeech("Send it", { ...voiceOk, approvalVoice: undefined, approvalTap: "bulk_send" }, [], on)).toEqual({ text: "Sending to that many people is a tap. It's on screen." });
    // Spoken approvals off for this call (sealed when it started), whatever the stage says.
    expect(routeSpeech("Send it", voiceOk, [])).toEqual({ text: "Approvals are taps for now. It's on screen." });
    expect(quickRoute([mark({ stage: voiceOk }), user("Send it")])).toEqual({ text: "Approvals are taps for now. It's on screen." });
    // A page from before spoken approvals says nothing of it: a tap.
    expect(routeSpeech("Send it", { working: false, approval: "Send it" }, [], on)).toEqual({ text: "That one's a tap. It's on screen." });
  });

  it("declines any request on a clear no", () => {
    expect(routeSpeech("Don't send it", voiceOk, [], on)).toEqual(declineTool);
    expect(routeSpeech("No, cancel that", money, [], on)).toEqual(declineTool);
    expect(quickRoute([mark({ stage: money }), user("never mind")])).toEqual(declineTool);
    // A bare stop with nothing running stays quiet, as before.
    expect(quickRoute([mark({ stage: money }), user("stop")])).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
  });

  it("answers agreement with how to approve, and holds talk about it until it's answered", () => {
    expect(quickRoute([mark({ stage: voiceOk }), user("Yes")], on)).toEqual({ text: "Say “send it” to go ahead, or tap." });
    expect(quickRoute([mark({ stage: voiceOk }), user("and cc Sam")], on)).toEqual({ text: "Got it. That goes along once the request on screen is answered.", tools: [{ name: "send_message", args: {} }] });
    expect(quickRoute([mark({ stage: money }), user("and cc Sam")], on)).toEqual({ text: "Got it. That goes along once you've OK'd the request on screen.", tools: [{ name: "send_message", args: {} }] });
    expect(quickRoute([mark({ stage: voiceOk }), user("wait")], on)).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
    // A change of course declines it (the browser steers): no word of it waiting.
    expect(quickRoute([mark({ stage: voiceOk }), user("Actually, send it to Sam")], on)).toEqual({ text: "Sure, one moment.", tools: [{ name: "send_message", args: {} }] });
  });

  it("says the hold stopped when they speak during it", () => {
    const approving = { ...voiceOk, approving: true };
    expect(quickRoute([mark({ stage: approving }), user("wait")], on)).toEqual({ text: "Okay, I've held off. It's still waiting on you." });
    expect(quickRoute([mark({ stage: approving }), user("change the subject")], on)).toEqual({
      text: "Okay, I've held off. It's still waiting on you.",
      tools: [{ name: "send_message", args: {} }],
    });
    expect(quickRoute([mark({ stage: approving }), user("send it")], on)).toEqual(approveTool);
    expect(quickRoute([mark({ stage: approving }), user("mm-hm")], on)).toEqual({ tools: [{ name: "skip_turn", args: {} }] });
  });

  it("holds off, never declines, on the hold's own words during it", () => {
    const approving = { ...voiceOk, approving: true };
    const heldOff = { text: "Okay, I've held off. It's still waiting on you." };
    for (const words of ["cancel that", "cancel it", "Cancel", "no, cancel that", "hold on", "stop"]) {
      expect(quickRoute([mark({ stage: approving }), user(words)], on), words).toEqual(heldOff);
      expect(routeSpeech(words, approving, [], on), words).toEqual(heldOff);
    }
    // A decline the hold's words don't cover still declines.
    expect(quickRoute([mark({ stage: approving }), user("don't send it")], on)).toEqual(declineTool);
    expect(quickRoute([mark({ stage: approving }), user("never mind")], on)).toEqual(declineTool);
    // With no hold running, "cancel that" is a no.
    expect(quickRoute([mark({ stage: voiceOk }), user("cancel that")], on)).toEqual(declineTool);
  });

  it("says fixed words for what the browser did with it", () => {
    expect(speechForResults(["Approving: in three seconds, unless they say wait or tap Cancel."])).toBe("Okay, going ahead in three seconds. Say “wait”, or tap Cancel.");
    expect(speechForResults(["Declined: the request that was waiting on their OK."])).toBe("Okay, declined.");
    expect(speechForResults(["Held off: the hold stopped; the request is still waiting on them."])).toBe("Okay, I've held off. It's still waiting on you.");
    expect(speechForResults(["Tap: spent"])).toBe("That one's a tap now. It's on screen.");
    expect(speechForResults(["Tap: typed"])).toBe("Typed words don't approve it. Say “send it”, or tap Approve.");
    expect(speechForResults(["Tap: money"])).toBe("Payments are a tap. It's on screen.");
    expect(speechForResults(["Tap: spent"])).toBe("That one's a tap now. It's on screen.");
    expect(tapLine("whatever")).toBe("That one's a tap. It's on screen.");
    // The read-back is said again as a Studio line: the voice itself stays quiet.
    const turns: FrontMessage[] = [
      mark({ stage: voiceOk }),
      user("send it"),
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "send_card", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Reading: it's read back first; then their own spoken “send it” counts." },
    ];
    expect(planReply(context, turns)).toEqual({ kind: "skip" });
    expect(planReply(context, [...turns.slice(0, 3), { role: "tool", tool_call_id: "c1", content: "Approving: in three seconds." }])).toEqual({
      kind: "say",
      text: "Okay, going ahead in three seconds. Say “wait”, or tap Cancel.",
    });
  });

  it("keeps the stage's word on it, and drops anything else", () => {
    const parsed = latestStage([mark({ stage: { ...voiceOk, approving: true, approvalTap: "money", extra: "x" } as VoiceStage })]);
    expect(parsed).toMatchObject({ approval: "Send the reply to Casting Co", approvalVoice: true, approving: true, approvalTap: "money" });
    expect(parsed).not.toHaveProperty("extra");
  });

  it("never lets the model answer it, even after a tool result", async () => {
    const reply = { choices: [{ message: { content: "", tool_calls: [{ function: { name: "send_card", arguments: "{}" } }, { function: { name: "stop_work", arguments: "{}" } }] } }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
    const request = {
      messages: [
        mark({ stage: voiceOk }),
        user("hmm"),
        { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "send_message", arguments: "{}" } }] },
        { role: "tool" as const, tool_call_id: "c1", content: "Refused: they haven't said anything new to pass on." },
      ],
    };
    const out = await modelReply({ baseUrl: "https://llm.example", apiKey: "k", model: "m" }, { ...context, approvals: true }, request, new AbortController().signal);
    expect(out.tools?.some((t) => t.name === "send_card" || t.name === "stop_work")).toBeFalsy();
    fetchMock.mockRestore();
  });

  it("describes it to the voice as Studio's to answer", () => {
    expect(describeStage(voiceOk)).toContain(`Waiting on the member's OK (Studio reads it back; their own "send it", or a tap): Send the reply to Casting Co`);
    expect(describeStage(money)).toContain("Waiting on the member's OK (a tap): Pay Casting Co");
    expect(describeStage({ ...voiceOk, approving: true })).toContain("anything they say stops it");
    expect(voicePrompt(context, voiceOk)).toContain("never by you");
  });
});
