import { describe, expect, it } from "vitest";
import { approvalActions, buildRequest, createLangflowAdapter, endedOnHold, fillTemplate, HOLD_NUDGE, langflowSessionId, leadingNotes, openingLineIndexes, selfContext, separateAroundTools, templateValues, toolBrowserSessions, toolQuestions, toolMemoryProposals, toolTaskUpdates, toolTimelines, toolUi, type LangflowConfig } from "./langflow";
import { AgentError, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "./types";

// Wire fixtures follow what Langflow 1.12.5 actually sends (captured from a live server and
// its event manager source): JSON objects separated by a blank line.

const tenantA: AgentTenantContext = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Alice Atelier",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  composioUserId: "lj_alice",
  composioToolkits: {},
  profile: "Handmade rings.",
  agentInstructions: "Be brief.",
  memories: ["Fiscal year starts in February"],
};
const tenantB: AgentTenantContext = {
  ...tenantA,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "Bob Bakery",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  composioUserId: "lj_bob",
  profile: "Sourdough.",
  memories: [],
};

const base: LangflowConfig = { baseUrl: "http://langflow.test", apiKey: "lf-key", flowId: "flow-1", stream: true };

function input(tenant: AgentTenantContext, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    conversationId: "c0ffee00-0000-4000-8000-000000000000",
    threadId: null,
    message: "Hello",
    history: [],
    tenant,
    attachments: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

const frame = (event: string, data: unknown) => `${JSON.stringify({ event, data })}\n\n`;

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

const JOB = "4b7c0d1e-0000-4000-8000-000000000001";

/**
 * Runs the adapter against a fake Langflow: starting a run returns a job, reading the job's
 * events returns `response`. A non-stream `response` is what starting the run returns.
 */
async function run(config: LangflowConfig, response: Response, i = input(tenantA), routes: Record<string, () => Response> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const isStream = response.headers.get("content-type")?.includes("event-stream");
  const adapter = createLangflowAdapter({
    ...config,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      for (const [suffix, make] of Object.entries(routes)) if (url.includes(suffix)) return make();
      if (url.endsWith("/api/v2/workflows")) return isStream ? Response.json({ job_id: JOB, status: "queued" }) : response;
      if (url.endsWith(`/api/v2/workflows/${JOB}/events`)) return response;
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  const events: AgentEvent[] = [];
  let error: unknown;
  try {
    for await (const e of adapter.run(i)) events.push(e);
  } catch (e) {
    error = e;
  }
  return { events, error, calls };
}

const user = (text: string) => ({ sender: "User", sender_name: "User", text, session_id: "s", content_blocks: [] });
const bot = (text: string, contents: unknown[] = [], id = "msg-1") => ({
  id,
  sender: "Machine",
  sender_name: "AI",
  text,
  session_id: "s",
  content_blocks: contents.length ? [{ title: "Agent Steps", contents }] : [],
});
const end = (text: string) => ({ result: { session_id: "s", outputs: [{ inputs: {}, outputs: [{ results: { message: bot(text) } }] }] } });

describe("Langflow request", () => {
  it("scopes the session to the workspace and conversation and sends only the caller's ids", () => {
    const { url, init } = buildRequest({ ...base, endUserHeader: "X-End-User" }, input(tenantA));
    expect(url).toBe("http://langflow.test/api/v2/workflows");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("lf-key");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID"]).toBe("lj_alice");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-WORKSPACE_ID"]).toBe(tenantA.workspaceId);
    expect(headers["X-End-User"]).toBe(`${tenantA.workspaceId}.${tenantA.userId}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ flow_id: "flow-1", input_value: "Hello", mode: "background", stream_protocol: "langflow" });
    expect(body.session_id).toBe(langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000"));
    expect(JSON.stringify(init)).not.toContain("lj_bob");
  });

  it("gives two tenants different sessions for the same conversation id", () => {
    const a = JSON.parse(buildRequest(base, input(tenantA)).init.body as string).session_id;
    const b = JSON.parse(buildRequest(base, input(tenantB)).init.body as string).session_id;
    expect(a).not.toBe(b);
    expect(a.startsWith(tenantA.workspaceId)).toBe(true);
  });

  it("ignores a stored thread id when choosing the session (it can't be redirected)", () => {
    const body = JSON.parse(buildRequest(base, input(tenantA, { threadId: `${tenantB.workspaceId}.someone-else` })).init.body as string);
    expect(body.session_id.startsWith(tenantA.workspaceId)).toBe(true);
    expect(body.session_id.split(".")[1]).toBe(tenantA.composioUserId);
  });

  it("fills the tweaks template with the caller's context", () => {
    const tweaks = { "Agent-x": { system_prompt: "{{system_context}}" }, "Composio-y": { entity_id: "{{composio_user_id}}" } };
    const body = JSON.parse(buildRequest({ ...base, tweaks }, input(tenantA)).init.body as string);
    expect(body.tweaks["Composio-y"].entity_id).toBe("lj_alice");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Handmade rings.");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Fiscal year starts in February");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Be brief.");
    expect(body.tweaks["Agent-x"].system_prompt).toMatch(/current conversation decides the topic.*Don't narrow a search or answer by the location/);
    expect(fillTemplate({ k: "{{unknown}}" }, {})).toEqual({ k: "{{unknown}}" });
  });

  it("tells the agent who it is to the member, or that it has no name yet, only where companions are on", () => {
    const named = templateValues({ ...tenantA, self: { name: "Juniper", manner: "I keep it short." } }).system_context;
    expect(named).toContain("you go by Juniper.");
    expect(named).toContain("How you talk with them, in your own words: I keep it short.");
    expect(named).toContain("never in how much you say");
    expect(named.indexOf("you go by Juniper")).toBeGreaterThan(named.indexOf("This agent:"));
    expect(templateValues({ ...tenantA, self: { name: null, manner: null } }).system_context).toContain("You don't have a name of your own with them yet.");
    const off = templateValues({ ...tenantA, self: null }).system_context;
    expect(off).not.toContain("go by");
    expect(off).not.toContain("name of your own");
  });

  it("names the page the member is looking at as they talk, so \"this\" means something", () => {
    expect(templateValues({ ...tenantA, modality: "call", screen: { kind: "task", title: "Weekly job digest", status: "active" } }).system_context).toContain(
      'On the member\'s screen as they said this: their task "Weekly job digest" (active).',
    );
    expect(templateValues({ ...tenantA, screen: { kind: "tracker", name: "Applications" } }).system_context).toContain('their "Applications" tracker');
    expect(templateValues(tenantA).system_context).not.toContain("On the member's screen");
  });

  it("tells the gateway when an event in the member's app started the run, and nothing otherwise", () => {
    expect(templateValues({ ...tenantA, runCause: "watch" }).run_cause).toBe("watch");
    expect(templateValues(tenantA).run_cause).toBe("");
  });

  it("says it's introduced on calls by its starting name, not one they chose, and keeps a chosen manner before a name", () => {
    const calls = selfContext({ name: null, manner: "I keep it short.", callName: "Rowan" });
    expect(calls).toContain("on calls you're introduced as Rowan, this agent's starting name, not one they chose for you.");
    expect(calls).toContain("suggest it with propose_agent (identity)");
    expect(calls).toContain("How you talk with them, in your own words: I keep it short.");
    expect(calls).not.toContain("go by");
    // Where it can't be given a name (voice without companions), it doesn't offer to take one.
    const voiceOnly = selfContext({ name: null, manner: null, callName: "Rowan", naming: false });
    expect(voiceOnly).toContain("introduced as Rowan");
    expect(voiceOnly).not.toContain("propose_agent");
    expect(voiceOnly).not.toContain("never in how much you say");
    // A kept name is the name, on calls too.
    expect(selfContext({ name: "Juniper", manner: null, callName: null })).toBe(
      "Who you are to them: you go by Juniper. Let it show in how you say things, never in how much you say, and never make a show of it.",
    );
  });

  it("tells it the voice it speaks with, and how to offer others when they'd like a change", () => {
    const sound = selfContext({ name: "Sara", manner: null, voice: "easygoing" });
    expect(sound).toContain("you speak in the Easygoing voice (smooth and friendly, on the lower side).");
    expect(sound).toContain("offer two or three other voices with propose_agent, as sound only");
    expect(sound).toContain("none marked as your pick");
    expect(sound).toContain("- gentle: Gentle.");
    // Without voice, nothing about how it sounds.
    expect(selfContext({ name: "Sara", manner: null })).not.toContain("voice");
  });

  it("tells the agent about its task and the member's tracker, only when there are some", () => {
    const system = templateValues({
      ...tenantA,
      task: { title: "Job hunt", instructions: "Find PM roles.", plan: [{ text: "Find roles", status: "doing", note: null }] },
      tracker: [{ collection: "applications", key: "https://jobs.example/1", title: "PM — Acme", status: "applied" }],
    }).system_context;
    expect(system).toContain('works on the member\'s task "Job hunt"');
    expect(system).toContain("- [doing] Find roles");
    expect(system).toContain("- applications | https://jobs.example/1 | PM — Acme | applied");
    const plain = templateValues({ ...tenantA, task: null }).system_context;
    expect(plain).not.toContain("tracker");
    expect(plain).not.toContain("task");
    expect(templateValues({ ...tenantA, tracker: [] }).system_context).toContain("The member has a tracker, empty so far.");
  });

  it("puts what done looks like above the steps, for a task's plan, the setup's, and any other conversation's", () => {
    const task = templateValues({
      ...tenantA,
      task: { title: "Job hunt", instructions: "", goal: "two roles worth applying to", plan: [{ text: "Find roles", status: "doing", note: null }] },
    }).system_context;
    expect(task).toContain("Plan so far:\nDone means: two roles worth applying to\n- [doing] Find roles");
    const setup = templateValues({ ...tenantA, setup: { plan: [{ text: "Your bar", status: "doing" }], goal: "a setup you'd trust" } }).system_context;
    expect(setup).toContain("Setup checklist so far:\nDone means: a setup you'd trust\n- [doing] Your bar");
    const own = templateValues({
      ...tenantA,
      plan: { goal: "three caterers under $40 a head", steps: [{ text: "Search caterers", status: "done", note: "Found 9" }, { text: "Shortlist", status: "doing", note: null }] },
    }).system_context;
    expect(own).toContain("Your plan for the work in this conversation so far");
    expect(own).toContain("Done means: three caterers under $40 a head\n- [done] Search caterers (Found 9)\n- [doing] Shortlist");
    expect(own).toContain("Keep it current with update_plan");
    // No goal said yet: just the steps.
    expect(templateValues({ ...tenantA, plan: { goal: null, steps: [{ text: "Search", status: "todo", note: null }] } }).system_context).not.toContain("Done means");
    expect(templateValues({ ...tenantA, plan: null }).system_context).not.toContain("Your plan for the work");
  });

  it("tells the agent what done means for a task (or the setup) before there's a plan, and to keep a task's goal", () => {
    // The member said it on the task page before the first run.
    const fresh = templateValues({ ...tenantA, task: { title: "Job hunt", instructions: "", goal: "two interviews booked", plan: [] } }).system_context;
    expect(fresh).toContain("There's no plan yet.\nDone means: two interviews booked\nIf the task has several steps, write a plan toward that with update_plan.");
    expect(fresh).toContain("The task's goal stays as it is when you leave update_plan's goal empty");
    const none = templateValues({ ...tenantA, task: { title: "Job hunt", instructions: "", goal: null, plan: [] } }).system_context;
    expect(none).toContain("with what done looks like as its goal");
    expect(none).not.toContain("Done means");
    expect(none).not.toContain("The task's goal stays");
    const setup = templateValues({ ...tenantA, setup: { plan: [], goal: "a setup you'd trust" } }).system_context;
    expect(setup).toContain("Done means: a setup you'd trust\nThere's no setup checklist yet");
  });

  it("lists the member's Library so the agent reopens what it made, only when there's something in it", () => {
    const system = templateValues({
      ...tenantA,
      library: [
        { title: "Job search tracker", kind: "spreadsheet", url: "https://docs.google.com/spreadsheets/d/1", pinned: true },
        { title: "Cover letter  draft", kind: "document", url: "https://docs.google.com/document/d/2", pinned: false },
      ],
    }).system_context;
    expect(system).toContain("rather than making a new copy");
    expect(system).toContain("- [pinned] Job search tracker | spreadsheet | https://docs.google.com/spreadsheets/d/1");
    expect(system).toContain("- Cover letter draft | document | https://docs.google.com/document/d/2");
    expect(templateValues({ ...tenantA, library: [] }).system_context).not.toContain("Library");
    expect(templateValues(tenantA).system_context).not.toContain("Library");
  });

  it("shows the agent how the member's bar is holding up, and what they passed on and why", () => {
    const system = templateValues({
      ...tenantA,
      setup: { plan: [{ text: "Your bar", status: "done", note: "Bar set: 6 criteria" }] },
      bar: { kept: 4, judged: 5, days: 7, passes: [{ title: "Designer II · Beta", reason: "Too junior" }, { title: "Lead · Gamma", reason: null }] },
    }).system_context;
    expect(system).toContain("they kept 4 of the 5 results they judged in the last 7 days");
    expect(system).toContain("- Designer II · Beta (Too junior)\n- Lead · Gamma");
    expect(system).toContain("- [done] Your bar (Bar set: 6 criteria)");
    expect(templateValues({ ...tenantA, bar: undefined }).system_context).not.toContain("member's bar");
    expect(system).not.toContain("missed their bar");
  });

  it("has the agent ask what to look for instead after the member passed on most of the last results", () => {
    const lastBatch = {
      judged: 4,
      kept: 0,
      items: [
        { title: "Senior PM · Coast", verdict: "pass" as const, reason: "Too early-stage" },
        { title: "PM · Fomo", verdict: "pass" as const, reason: null },
        { title: "Staff PM · Ramp", verdict: "pass" as const, reason: "Not NYC" },
        { title: "PM · Brex", verdict: "pass" as const, reason: null },
      ],
      since: [],
    };
    const bar = { kept: 0, judged: 4, days: 7, passes: [{ title: "PM · Brex", reason: null }, { title: "Lead · Older", reason: "Agency" }], lastBatch };
    const system = templateValues({ ...tenantA, bar }).system_context;
    expect(system).toContain("missed their bar: they passed on all 4.\n- Passed: Senior PM · Coast (Too early-stage)\n- Passed: PM · Fomo\n");
    expect(system).toContain("ask them what to look for instead: one ask_user");
    expect(system).toContain("They haven't said anything in other chats since then.");
    // The other passes still show; the batch's own aren't listed twice.
    expect(system).toContain("- Lead · Older (Agency)");
    expect(system.match(/PM · Brex/g)).toHaveLength(1);

    const partly = { ...lastBatch, kept: 1, items: [{ ...lastBatch.items[0], verdict: "keep" as const, reason: null }, ...lastBatch.items.slice(1)] };
    const later = templateValues({ ...tenantA, bar: { ...bar, kept: 1, lastBatch: { ...partly, since: ["Only Series B+ fintech in NYC"] } } }).system_context;
    expect(later).toContain("they passed on 3 of the 4.\n- Kept: Senior PM · Coast\n");
    expect(later).toContain(`What they've said in other chats since then:\n- "Only Series B+ fintech in NYC"`);

    // A missed batch from before this week still asks, without a score of nothing.
    const old = templateValues({ ...tenantA, bar: { kept: 0, judged: 0, days: 7, passes: [], lastBatch } }).system_context;
    expect(old).toContain("missed their bar");
    expect(old).not.toContain("they kept 0 of the 0");
  });

  it("keeps the setup instructions in view for the whole interview, not just its first message", () => {
    const during = templateValues({ ...tenantA, setup: { plan: [], instructions: "SETUP-RULES-XYZ" } }).system_context;
    expect(during).toContain("How to run the setup interview");
    expect(during).toContain("SETUP-RULES-XYZ");
    const after = templateValues({ ...tenantA, setup: { plan: [] } }).system_context;
    expect(after).not.toContain("How to run the setup interview");
  });

  it("tells the agent when it's in its setup interview, and shows saved reference notes with their fields", () => {
    const system = templateValues({
      ...tenantA,
      setup: { plan: [{ text: "Your résumé", status: "done" }, { text: "Your search", status: "doing" }] },
      notes: [{ collection: "stories", title: "Fixed onboarding", fields: { situation: "Signups  stalled", result: "Up 18%", nested: { x: 1 } } }],
    }).system_context;
    expect(system).toContain("This conversation is this agent's setup interview");
    expect(system).toContain("- [done] Your résumé\n- [doing] Your search");
    expect(system).toContain("- [stories] Fixed onboarding (situation: Signups stalled; result: Up 18%)");
    const plain = templateValues({ ...tenantA, setup: null, notes: [] }).system_context;
    expect(plain).not.toContain("setup interview");
    expect(plain).not.toContain("reference notes");
    const many = Array.from({ length: 200 }, (_, i) => ({ collection: "stories", title: `Story ${i}`, fields: { result: "x".repeat(50) } }));
    expect(templateValues({ ...tenantA, notes: many }).system_context.length).toBeLessThan(templateValues(tenantA).system_context.length + 3300);
  });

  it("reads plan updates, tracker rows, and Library links only from tools that declare them", () => {
    const message = {
      content_blocks: [
        {
          contents: [
            { type: "tool_use", name: "update_plan", output: JSON.stringify({ plan_update: { steps: [{ text: "a", status: "todo" }] } }) },
            { type: "tool_use", name: "update_plan", output: JSON.stringify({ plan_update: { steps: [{ text: "b", status: "doing" }], goal: "a and b done" } }) },
            { type: "tool_use", name: "save_record", output: { record: { collection: "applications", key: "k" } } },
            { type: "tool_use", name: "report_run", output: { run_report: { outcome: "nothing_new", summary: "" } } },
            { type: "tool_use", name: "web_search", output: { results: [] } },
            { type: "tool_use", name: "save_record", output: { record: { collection: "x", key: "y" } }, error: true },
            { type: "tool_use", name: "file_link", output: JSON.stringify({ library_item: { url: "https://docs.google.com/document/d/1", title: "Plan" }, note: "Saved." }) },
            { type: "tool_use", name: "file_link", output: "Not saved: give it a title the owner will recognize." },
            { type: "tool_use", name: "file_link", output: { library_item: { url: "https://x.example", title: "X" } }, error: true },
          ],
        },
      ],
    };
    expect(toolTaskUpdates(message as never)).toEqual([
      // A flow from before goals sends none; the app keeps the current one.
      { type: "plan-update", plan: [{ text: "a", status: "todo" }], goal: undefined },
      { type: "plan-update", plan: [{ text: "b", status: "doing" }], goal: "a and b done" },
      { type: "record", record: { collection: "applications", key: "k" } },
      { type: "run-report", report: { outcome: "nothing_new", summary: "" } },
      { type: "library-item", item: { url: "https://docs.google.com/document/d/1", title: "Plan" } },
    ]);
  });

  it("describes the workspace by what the agent is for, not as a business", () => {
    const values = templateValues(tenantA);
    expect(values.system_context).toContain("This agent: Alice Atelier");
    expect(values.system_context).toContain("What this agent is for:\nHandmade rings.");
    expect(values.system_context).not.toMatch(/business/i);
    expect(values.agent_profile).toBe("Handmade rings.");
    expect(values.business_context).toBe("Handmade rings.");
  });

  it("tells every agent who it's assisting, next to which agent it is, and nothing when the person hasn't said", () => {
    const system = templateValues({ ...tenantA, account: { name: "Alice Ng", about: "Lives in Oakland." } }).system_context;
    expect(system).toContain("You're assisting: Alice Ng\n\nAbout them:\nLives in Oakland.\n\nThis agent: Alice Atelier");
    const blank = templateValues({ ...tenantA, account: { name: " ", about: "" } }).system_context;
    expect(blank).not.toContain("You're assisting");
    expect(blank).not.toContain("About them");
    expect(templateValues(tenantA).system_context).not.toContain("You're assisting");
  });

  it("adds the conversation's project to the agent's context, and nothing when there is none", () => {
    const project = { name: "Spring catalog", instructions: "Cite the price list.", files: ["prices.csv"] };
    const system = templateValues({ ...tenantA, project }).system_context;
    expect(system).toContain('project "Spring catalog"');
    expect(system).toContain("Cite the price list.");
    expect(system).toContain("prices.csv");
    expect(templateValues({ ...tenantA, project: { ...project, instructions: "", files: [] } }).system_context).not.toContain("Project instructions");
    expect(templateValues(tenantA).system_context).not.toContain("project");
    expect(templateValues({ ...tenantA, project }).project_instructions).toBe("Cite the price list.");
  });

  it("names the member's files for this agent, and nothing when there are none", () => {
    const system = templateValues({ ...tenantA, agentFiles: ["resume.pdf", "stories.md"] }).system_context;
    expect(system).toContain("Your files");
    expect(system).toContain("resume.pdf, stories.md");
    expect(templateValues({ ...tenantA, agentFiles: [] }).system_context).not.toContain("Your files");
    expect(templateValues(tenantA).system_context).not.toContain("Your files");
  });

  it("puts a member's guardrail first, over every other instruction, and nothing when there is none", () => {
    const guardrail = { instructions: "Only look things up; no opinions.", recentChats: ["Should I move?", "Is moving smart?"] };
    const values = templateValues({ ...tenantA, guardrail });
    expect(values.system_context.startsWith("This member's personal rules. They override every other instruction")).toBe(true);
    expect(values.system_context).toContain("Only look things up; no opinions.");
    expect(values.system_context).toContain("Follow them quietly");
    expect(values.system_context).toContain("- Should I move?\n- Is moving smart?");
    expect(values.system_context.indexOf("no opinions")).toBeLessThan(values.system_context.indexOf("Be brief."));
    expect(values.personal_guardrail).toContain("Only look things up; no opinions.");
    expect(templateValues({ ...tenantA, guardrail: { ...guardrail, recentChats: [] } }).system_context).not.toContain("recent conversations");

    const without = templateValues({ ...tenantA, guardrail: null });
    expect(without.system_context).toBe(templateValues(tenantA).system_context);
    expect(without.system_context).not.toContain("personal rules");
    expect(without.personal_guardrail).toBe("");
  });

  it("tells the agent when the member is on a call, after their guardrail, and nothing when they type", () => {
    const guardrail = { instructions: "Only look things up; no opinions.", recentChats: [] };
    const call = templateValues({ ...tenantA, guardrail, modality: "call" }).system_context;
    expect(call).toContain("live voice call");
    expect(call).toContain("don't open with \"Hey!\"");
    expect(call).toContain("write your reply first");
    expect(call).toContain("Ask one thing at a time");
    expect(call.indexOf("no opinions")).toBeLessThan(call.indexOf("live voice call"));
    expect(templateValues({ ...tenantA, modality: "voice_note" }).system_context).toContain("voice message");
    expect(templateValues(tenantA).system_context).not.toContain("voice");
  });

  it("tells the agent a voice message gets a voice note back, said from the reply's first two sentences", () => {
    const guardrail = { instructions: "Only look things up; no opinions.", recentChats: [] };
    const note = templateValues({ ...tenantA, guardrail, modality: "voice_note" }).system_context;
    expect(note).toContain("expect speech-to-text slips");
    expect(note).toContain("your first two sentences, under about 50 words together, are what they hear");
    expect(note).toContain("Details, links, lists, and choices go after them");
    expect(note.indexOf("no opinions")).toBeLessThan(note.indexOf("voice message"));
    // A call isn't a voice note.
    expect(templateValues({ ...tenantA, modality: "call" }).system_context).not.toContain("voice note");
  });

  it("asks for a task report written for the ear only when it's heard as a voice note", () => {
    const task = { title: "Job hunt", instructions: "Find PM roles.", plan: [] };
    const heard = templateValues({ ...tenantA, task, voiceNotes: true }).system_context;
    expect(heard).toContain("they hear your report_run summary as a voice note");
    expect(heard).toContain("no symbols, lists, or links, in 300 characters at most");
    expect(templateValues({ ...tenantA, task }).system_context).not.toContain("voice note");
    // Only a task's runs report.
    expect(templateValues({ ...tenantA, voiceNotes: true }).system_context).not.toContain("report_run summary");
  });

  it("gives the Member Apps node this member's id and the offered apps, nobody else's", () => {
    const tweaks = { "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" } };
    const tenant = { ...tenantA, composioToolkits: { gmail: "ac_gmail" } };
    const body = JSON.parse(buildRequest({ ...base, tweaks }, input(tenant)).init.body as string);
    expect(body.tweaks["MemberApps-studio"].member_id).toBe("lj_alice");
    expect(JSON.parse(body.tweaks["MemberApps-studio"].toolkits)).toEqual({ gmail: "ac_gmail" });
    const other = JSON.parse(buildRequest({ ...base, tweaks }, input(tenantB)).init.body as string);
    expect(other.tweaks["MemberApps-studio"].member_id).toBe(tenantB.composioUserId);
  });

  it("puts uploaded files where the template says, and leaves the field out when there are none", () => {
    const tweaks = { "ChatInput-1": { files: "{{files}}" } };
    expect(fillTemplate(tweaks, {}, ["u/a.csv"])).toEqual({ "ChatInput-1": { files: ["u/a.csv"] } });
    expect(fillTemplate(tweaks, {}, [])).toEqual({ "ChatInput-1": {} });
  });

  it("never puts non-ASCII or multi-line values into headers", () => {
    const { init } = buildRequest(base, input({ ...tenantA, composioUserId: "bad\nvalue" }));
    expect((init.headers as Record<string, string>)["X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID"]).toBeUndefined();
  });
});

describe("Langflow streaming", () => {
  it("streams tokens and reports the namespaced thread", async () => {
    const { events, error } = await run(
      base,
      streamResponse([
        frame("add_message", user("Hello")),
        frame("add_message", bot("")),
        frame("token", { chunk: "Hi ", id: "msg-1" }),
        frame("token", { chunk: "there", id: "msg-1" }),
        frame("end", end("Hi there")),
      ]),
    );
    expect(error).toBeUndefined();
    expect(events[0]).toEqual({ type: "thread", threadId: langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000") });
    // Short text is held until it's clear it isn't an opening line, then released whole.
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toBe("Hi there");
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("reports the job id as the run's trace id (Langflow traces a background job under it)", async () => {
    const { events } = await run(base, streamResponse([frame("end", end("Hi"))]));
    expect(events.filter((e) => e.type === "trace")).toEqual([{ type: "trace", traceId: JOB }]);
  });

  it("uses the bot message when the flow doesn't stream tokens (verified echo-flow shape)", async () => {
    const { events } = await run(base, streamResponse([frame("add_message", user("Hello")), frame("add_message", bot("Hello")), frame("end", end("Hello"))]));
    expect(events.filter((e) => e.type === "message")).toEqual([{ type: "message", text: "Hello" }]);
  });

  it("handles frames split across chunks", async () => {
    const all = frame("add_message", bot("Split answer")) + frame("end", end("Split answer"));
    const { events } = await run(base, streamResponse([all.slice(0, 17), all.slice(17, 60), all.slice(60)]));
    expect(events).toContainEqual({ type: "message", text: "Split answer" });
  });

  it("turns tool calls into running → done activity, and structured outputs into artifacts", async () => {
    const running = { type: "tool_use", name: "GOOGLESHEETS_CREATE", tool_input: { title: "Q3" }, output: null, error: null };
    const done = {
      ...running,
      output: { artifact: { id: "sheet-1", kind: "spreadsheet", title: "Q3", url: "https://docs.google.com/spreadsheets/d/x" } },
    };
    const { events } = await run(
      base,
      streamResponse([frame("add_message", bot("", [running])), frame("add_message", bot("", [done])), frame("token", { chunk: "Done." }), frame("end", end("Done."))]),
    );
    const activity = events.filter((e) => e.type === "activity");
    expect(activity[0]).toMatchObject({ id: "msg-1:0", status: "running", label: "Creating a spreadsheet", app: "sheets" });
    expect(activity[1]).toMatchObject({ id: "msg-1:0", status: "done", label: "Created a spreadsheet", app: "sheets" });
    expect(events.filter((e) => e.type === "artifact")).toHaveLength(1);
  });

  it("shows gateway-wrapped tools as one plain-language step with a receipt (recorded shape)", async () => {
    const wrapper = { type: "tool_use", name: "execute_tool", tool_input: { tool_name: "search", arguments: { query: "casting houses nyc" } }, output: null, error: null };
    const inner = { type: "tool_use", name: "search", tool_input: { query: "casting houses nyc" }, output: null, error: null };
    const doneWrapper = { ...wrapper, output: { type: "tool", tool_call_id: "c1", content: "Title: Acme Casting\nURL: https://acme.example/" } };
    const doneInner = { ...inner, output: { results: [{ url: "https://acme.example/", title: "Acme Casting" }] } };
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, wrapper])),
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, wrapper, inner])),
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, doneWrapper, doneInner])),
        frame("token", { chunk: "Found one." }),
        frame("end", end("Found one.")),
      ]),
    );
    const steps = events.filter((e) => e.type === "activity") as Extract<AgentEvent, { type: "activity" }>[];
    const visible = steps.filter((e) => !e.hidden);
    expect(new Set(visible.map((e) => e.id))).toEqual(new Set(["msg-1:1"]));
    expect(visible[0]).toMatchObject({ status: "running", label: "Searching the web for “casting houses nyc”", app: "web" });
    expect(visible.at(-1)).toMatchObject({
      status: "done",
      label: "Searched the web for “casting houses nyc”",
      preview: { type: "sources", items: [{ title: "Acme Casting", url: "https://acme.example/", domain: "acme.example" }] },
    });
    expect(steps.find((e) => e.id === "msg-1:0")).toMatchObject({ hidden: true });
  });

  it("treats a line before a tool call as a note, and keeps it out of the answer (recorded shape)", async () => {
    const intro = "I'll look up the hours for this week.";
    const answer = "It's **closed only on Wednesday** this week.";
    const search = { type: "tool_use", name: "search", tool_input: { query: "museum hours" }, output: { results: [{ url: "https://museum.example/", title: "Hours" }] }, error: null };
    const textLeaf = (text: string) => ({ type: "text", text });
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", user("hours?")),
        frame("add_message", bot("")),
        frame("token", { chunk: "I'll look up the " }),
        frame("token", { chunk: "hours for this week." }),
        frame("add_message", bot(intro)),
        frame("add_message", bot(intro, [textLeaf(intro), search])),
        frame("token", { chunk: "It's **closed only on Wednesday** " }),
        frame("token", { chunk: "this week." }),
        frame("add_message", bot(intro + answer, [textLeaf(intro), search, textLeaf(answer), textLeaf(intro + answer)])),
        frame("end", end(intro + answer)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(answer);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  const deltas = (events: AgentEvent[]) =>
    events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
  const plan = (steps: unknown[] = []) => ({ type: "tool_use", name: "update_plan", tool_input: { steps }, output: "ok", error: null });

  it("keeps a reply written just before a plan update as the reply, when nothing else is said", async () => {
    const question = "So the invoices are the worst part. How do you invoice the cafés now?";
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: question }),
        frame("add_message", bot(question, [{ type: "text", text: question }, plan([{ text: "What you're after", status: "doing" }])])),
        frame("end", end(question)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: question }]);
    expect(events).toContainEqual({ type: "note-reply", text: question });
    expect(deltas(events)).toBe(question);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("keeps a greeting written before a plan update in front of the question that follows it", async () => {
    const hey = "Hey! First I'll learn what's hard, then suggest where I can help.";
    const question = "What's been hardest in the bakery lately?";
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: hey }),
        frame("add_message", bot(hey, [{ type: "text", text: hey }, plan()])),
        frame("token", { chunk: question }),
        frame("add_message", bot(hey + question, [{ type: "text", text: hey }, plan(), { type: "text", text: question }])),
        frame("end", end(hey + question)),
      ]),
    );
    expect(events.filter((e) => e.type === "note-reply")).toEqual([{ type: "note-reply", text: hey }]);
    expect(deltas(events)).toBe(`${hey}\n\n${question}`);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("puts a closing line kept back before a run report after the answer it closes", async () => {
    const answer = `${"Three roles cleared your bar today. ".repeat(9)}\n\nThe best is remote.`;
    const closing = "Want me to draft the first application?";
    const report = { type: "tool_use", name: "report_run", tool_input: { outcome: "update", summary: "3 roles" }, output: "ok", error: null };
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: answer }),
        frame("add_message", bot(answer, [{ type: "text", text: answer }, plan()])),
        frame("token", { chunk: closing }),
        frame("add_message", bot(answer + closing, [{ type: "text", text: answer }, plan(), { type: "text", text: closing }, report])),
        frame("end", end(answer + closing)),
      ]),
    );
    expect(deltas(events)).toBe(`${answer}\n\n${closing}`);
  });

  it("keeps a run of opening lines out of the reply when real work follows them", async () => {
    const first = "Let me plan this out.";
    const second = "Checking your calendar.";
    const answer = "You have two meetings tomorrow.";
    const search = { type: "tool_use", name: "GOOGLECALENDAR_FIND_EVENT", tool_input: {}, output: { items: [] }, error: null };
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: first }),
        frame("add_message", bot(first, [{ type: "text", text: first }, plan()])),
        frame("token", { chunk: second }),
        frame("add_message", bot(first + second, [{ type: "text", text: first }, plan(), { type: "text", text: second }, search])),
        frame("token", { chunk: answer }),
        frame("end", end(first + second + answer)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([
      { type: "note", text: first },
      { type: "note", text: second },
    ]);
    expect(events.some((e) => e.type === "note-reply")).toBe(false);
    expect(deltas(events)).toBe(answer);
  });

  it("finds the same opening lines in a whole reply as it does while streaming", () => {
    const t = (text: string) => ({ type: "text", text });
    const search = { type: "tool_use", name: "search", tool_input: {}, output: {}, error: null };
    // A run of short lines before work are opening lines; a line before only a plan update is the reply.
    expect(openingLineIndexes([t("Let me plan."), plan(), t("Checking now."), search, t("Found two.")])).toEqual([0, 2]);
    expect(openingLineIndexes([t("Hey! A few steps."), plan(), t("What's hardest?")])).toEqual([]);
    expect(openingLineIndexes([t("What's hardest?"), plan()])).toEqual([]);
  });

  it("keeps an opening line out of the reply when a plan update and then real work follow it", async () => {
    const intro = "Let me look for new roles.";
    const answer = "Found two that fit.";
    const search = { type: "tool_use", name: "search", tool_input: { query: "roles" }, output: { results: [] }, error: null };
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: intro }),
        frame("add_message", bot(intro, [{ type: "text", text: intro }, plan()])),
        frame("add_message", bot(intro, [{ type: "text", text: intro }, plan(), search])),
        frame("token", { chunk: answer }),
        frame("end", end(intro + answer)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    expect(events.some((e) => e.type === "note-reply" || e.type === "message")).toBe(false);
    expect(deltas(events)).toBe(answer);
  });

  it("doesn't take an opening line for the reply when real work followed it", async () => {
    const intro = "Let me look through your invoices.";
    const search = { type: "tool_use", name: "search", tool_input: { query: "invoices" }, output: { results: [] }, error: null };
    const plan = { type: "tool_use", name: "update_plan", tool_input: { steps: [] }, output: "ok", error: null };
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: intro }),
        frame("add_message", bot(intro, [{ type: "text", text: intro }, plan, search])),
        frame("end", end(intro)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("streams long answers token by token", async () => {
    const long = "word ".repeat(80);
    const { events } = await run(base, streamResponse([frame("token", { chunk: long }), frame("token", { chunk: "more" }), frame("end", end(long + "more"))]));
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual([long, "more"]);
  });

  it("releases short text as the answer when no tool follows", async () => {
    const { events } = await run(base, streamResponse([frame("token", { chunk: "Hey! " }), frame("token", { chunk: "Happy to help." }), frame("end", end("Hey! Happy to help."))]));
    expect(events.filter((e) => e.type === "note")).toEqual([]);
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toBe("Hey! Happy to help.");
  });

  it("strips opening lines from an answer that isn't streamed", async () => {
    const intro = "Let me check.";
    const message = bot(intro + "All clear.", [{ type: "text", text: intro }, { type: "tool_use", name: "search", tool_input: {}, output: { results: [] }, error: null }]);
    const { events } = await run({ ...base, stream: false }, streamResponse([frame("add_message", message), frame("end", { build_duration: 1 })]));
    expect(events).toContainEqual({ type: "message", text: "All clear." });
  });

  it("keeps a reply written before a plan update as the answer when it isn't streamed", async () => {
    const question = "How do you invoice the cafés now?";
    const plan = { type: "tool_use", name: "update_plan", tool_input: { steps: [] }, output: "ok", error: null };
    const message = bot(question, [{ type: "text", text: question }, plan]);
    const { events } = await run({ ...base, stream: false }, streamResponse([frame("add_message", message), frame("end", { build_duration: 1 })]));
    expect(events.filter((e) => e.type === "note")).toEqual([]);
    expect(events).toContainEqual({ type: "message", text: question });
  });

  it("takes back a reply that turned out to be an opening line when it isn't streamed", async () => {
    const intro = "I'll send the invoice to Jo.";
    const send = { type: "tool_use", name: "execute_tool", tool_input: { tool_name: "GMAIL_SEND_EMAIL", arguments: {} }, output: null, error: null };
    const steps = { type: "tool_use", name: "update_plan", tool_input: { steps: [] }, output: "ok", error: null };
    const { events } = await run(
      { ...base, stream: false },
      streamResponse([
        frame("add_message", bot(intro, [{ type: "text", text: intro }, steps])),
        frame("add_message", bot(intro, [{ type: "text", text: intro }, steps, send])),
        frame("end", end(intro)),
      ]),
    );
    expect(events.filter((e) => e.type === "message").at(-1)).toEqual({ type: "message", text: "" });
    expect(events).toContainEqual({ type: "note", text: intro });
  });

  it("keeps an answer written before a cite call as the answer, not an opening line", async () => {
    const answer = "Acme Atelier's listed address is 12 Example St, New York [1].";
    const cite = { type: "tool_use", name: "cite", tool_input: { sources: [{ n: 1, url: "https://acme.example/", quote: "12 Example St" }] }, output: "ok", error: null };
    const { events } = await run(
      base,
      streamResponse([
        frame("token", { chunk: answer }),
        frame("add_message", bot(answer, [{ type: "text", text: answer }, cite])),
        frame("end", end(answer)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(answer);
  });

  it("separates the parts of a reply around a card in the recorded shape, and only where a call fell", () => {
    const before = "I'll bring you a few options at a time and leave the choosing to you.";
    const after = "You can keep the name Wren or pick your own.";
    const propose = { type: "tool_use", name: "propose_agent", tool_input: { summary: "s", identity: { name: "Wren" } }, output: "{}", error: null };
    // Langflow keeps each part, the call between them, and the whole text again at the end.
    const message = bot(before + after, [{ type: "text", text: before }, propose, { type: "text", text: after }, { type: "text", text: before + after }]);
    expect(separateAroundTools(before + after, message)).toBe(`${before}\n\n${after}`);
    // No call between two parts: left as written.
    expect(separateAroundTools("One.Two.", bot("One.Two.", [{ type: "text", text: "One." }, { type: "text", text: "Two." }]))).toBe("One.Two.");
    // Parts that aren't in the text as joined (it was edited, or shaped otherwise): left alone.
    expect(separateAroundTools("Something else.", message)).toBe("Something else.");
  });

  it("shows a reply and the line after its card apart, streamed or not, with opening lines still taken out", async () => {
    const intro = "Let me look.";
    const before = "Found two roles that fit.";
    const after = "Keep the ones you like.";
    const search = { type: "tool_use", name: "search", tool_input: {}, output: { results: [] }, error: null };
    const form = { type: "tool_use", name: "show_form", tool_input: { title: "Roles", fields: [] }, output: "{}", error: null };
    const parts = [{ type: "text", text: intro }, search, { type: "text", text: before }, form, { type: "text", text: after }];
    const whole = { ...base, stream: false };
    const { events } = await run(whole, streamResponse([frame("add_message", bot(intro + before + after, parts)), frame("end", { build_duration: 1 })]));
    expect(events.filter((e) => e.type === "message").at(-1)).toEqual({ type: "message", text: `${before}\n\n${after}` });

    const streamed = await run(
      base,
      streamResponse([
        frame("token", { chunk: before }),
        frame("add_message", bot(before, [{ type: "text", text: before }, form])),
        frame("token", { chunk: after }),
        frame("end", end(before + after)),
      ]),
    );
    const text = streamed.events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(`${before}\n\n${after}`);
  });

  it("finds opening lines only before work, for every reporting tool and in any shape", () => {
    const intro = { type: "text", text: "Let me check." };
    const answer = { type: "text", text: "Here's what I found." };
    const work = { type: "tool_use", name: "search", tool_input: {} };
    for (const name of ["cite", "report_timeline", "report_visual", "ask_user", "show_form", "propose_agent", "merge_memories", "offer_call", "hand_browser", "remember", "propose_memory"]) {
      const direct = { type: "tool_use", name, tool_input: {} };
      const viaGateway = { type: "tool_use", name: "execute_tool", tool_input: { tool_name: name, arguments: {} } };
      expect(openingLineIndexes([intro, work, answer, direct])).toEqual([0]);
      expect(openingLineIndexes([intro, work, answer, viaGateway, direct])).toEqual([0]);
    }
    // Long or multi-paragraph text is the answer even when work follows.
    expect(openingLineIndexes([{ type: "text", text: "word ".repeat(80) }, work])).toEqual([]);
    expect(openingLineIndexes([{ type: "text", text: "First.\n\nSecond." }, work])).toEqual([]);
    expect(leadingNotes(bot("", [answer, { type: "tool_use", name: "remember", tool_input: {} }]))).toEqual([]);
  });

  it("reports a failed tool call", async () => {
    const failed = { type: "tool_use", name: "gmail_send", tool_input: {}, output: null, error: "Rate limited" };
    const { events } = await run(base, streamResponse([frame("add_message", bot("", [failed])), frame("end", end("Sorry."))]));
    expect(events.find((e) => e.type === "activity")).toMatchObject({ status: "failed", detail: "The app is rate-limiting requests right now.", app: "gmail" });
  });

  it("does not invent artifacts from text or unstructured tool output", async () => {
    const tool = { type: "tool_use", name: "search", output: "See https://docs.google.com/spreadsheets/d/abc", error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("Made https://docs.google.com/x", [tool])), frame("end", end("x"))]));
    expect(events.some((e) => e.type === "artifact")).toBe(false);
  });

  it("surfaces an in-stream error event as an AgentError", async () => {
    const { error } = await run(base, streamResponse([frame("add_message", user("x")), frame("error", { error: "Model quota exceeded" })]));
    expect(error).toBeInstanceOf(AgentError);
    expect((error as Error).message).toContain("Model quota exceeded");
  });

  it("explains model-provider failures in plain words", async () => {
    const { error } = await run(base, streamResponse([frame("error", { error: "APIStatusError: Error code: 402 - in_flight_budget_exhausted" })]));
    expect((error as Error).message).toMatch(/out of credit/);
  });

  it("reads the error message a component sends as the error event", async () => {
    // Langflow's shape when the Agent's model call fails mid-run (OpenRouter's in-flight budget).
    const message = {
      id: "m1",
      data: {
        text: "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.\n",
        category: "error",
        content_blocks: [{ title: "Error", contents: [{ type: "error", reason: "**APIStatusError**\n - **This request would exceed your available credits.**" }] }],
      },
    };
    const { error } = await run(base, streamResponse([frame("add_message", user("x")), frame("error", message)]));
    expect((error as Error).message).toMatch(/out of credit/);
    const fromReason = await run(base, streamResponse([frame("error", { data: { content_blocks: message.data.content_blocks } })]));
    expect((fromReason.error as Error).message).toMatch(/out of credit/);
  });

  it("maps HTTP failures to safe, specific errors", async () => {
    for (const [status, pattern, retryable] of [
      [403, /credentials/, false],
      [404, /flow wasn't found/, false],
      [500, /had a problem/, true],
    ] as const) {
      const { error } = await run(base, new Response("{}", { status }));
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).message).toMatch(pattern);
      expect((error as AgentError).retryable).toBe(retryable);
    }
  });

  it("reads steps and opening lines while a background job runs (recorded flat-block shape)", async () => {
    // Mid-run, Langflow 1.12.4 background jobs send the entries themselves as content blocks;
    // only the final message nests them in an "Agent Steps" block.
    const intro = "Let me find where your gold inventory is tracked.";
    const answer = "You have **16 gold pieces in stock**.";
    const discover = { type: "tool_use", name: "discover_tools", tool_input: { query: "inventory" }, output: { content: "[]" }, error: null };
    const read = {
      type: "tool_use",
      name: "execute_tool",
      tool_input: { tool_name: "search", arguments: { query: "gold inventory" } },
      output: null,
      error: null,
    };
    const flat = (text: string, blocks: unknown[]) => ({ ...bot(text), content_blocks: blocks });
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", flat("", [])),
        frame("token", { chunk: intro }),
        frame("add_message", flat(intro, [{ type: "text", text: intro }])),
        frame("add_message", flat(intro, [{ type: "text", text: intro }, discover, read])),
        frame("token", { chunk: answer }),
        frame("add_message", bot(intro + answer, [{ type: "text", text: intro }, discover, { ...read, output: { content: "ok" } }, { type: "text", text: answer }])),
        frame("end", {}),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(answer);
    // The step shows while it runs, then updates in place.
    const steps = events.filter((e) => e.type === "activity" && !e.hidden) as Extract<AgentEvent, { type: "activity" }>[];
    expect(steps[0]).toMatchObject({ id: "msg-1:1", status: "running" });
    expect(steps.at(-1)).toMatchObject({ id: "msg-1:1", status: "done" });
  });

  it("reads server-sent frames with data: and id: lines (recorded v2 shape)", async () => {
    const sse = (id: number, event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\nid: ${id}\n\n`;
    const { events, error } = await run(
      base,
      streamResponse([sse(1, "vertices_sorted", { ids: [] }), sse(2, "add_message", bot("Ready.")), sse(3, "end", { build_duration: 1 })]),
    );
    expect(error).toBeUndefined();
    expect(events).toContainEqual({ type: "message", text: "Ready." });
  });
});

// The pause Langflow sends when the Agent's approval middleware stops before take_action
// (recorded from Langflow 1.12.4 with the Studio Tool Gateway).
const approvalRequest = (requestId = "Agent-1:job:nonce") => ({
  request_id: requestId,
  kind: "tool_approval",
  prompt: "Tool execution requires approval\n\nTool: take_action\nArgs: {...}",
  options: [
    { action_id: "approve", label: "Approve" },
    { action_id: "reject", label: "Reject" },
  ],
  allowed_decisions: ["approve", "reject"],
  action_requests: [
    {
      name: "take_action",
      args: {
        tool_name: "composio_multi_execute_tool",
        arguments: {
          tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "jo@acme.example", subject: "March invoice", api_key: "sk-live-abcdefghijklmnopqrstuvwx" } }],
        },
        summary: "Email Jo the March invoice",
      },
      description: "Tool execution requires approval",
    },
  ],
});

describe("Langflow approvals", () => {
  const sse = (id: number, event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\nid: ${id}\n\n`;

  it("pauses with the agent's summary, the app, and readable details; secrets stay masked", async () => {
    const { events, error } = await run(
      base,
      streamResponse([sse(1, "add_message", user("Email Jo")), sse(2, "add_message", bot("")), sse(3, "remove_message", { id: "msg-1" }), sse(4, "human_input_required", approvalRequest())]),
    );
    expect(error).toBeUndefined();
    const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
    expect(approval).toMatchObject({ summary: "Email Jo the March invoice", app: "gmail" });
    expect(approval.details).toContainEqual(["Recipient email", "jo@acme.example"]);
    expect(approval.details).toContainEqual(["Subject", "March invoice"]);
    expect(JSON.stringify(approval.details)).not.toContain("abcdefghijklmnop");
    expect(approval.state).toEqual({ jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "4" });
    expect(events.at(-1)?.type).toBe("approval");
  });

  it("says what approving would run, as the gateway will run it, for deciding whether a call may approve it", async () => {
    const { events } = await run(base, streamResponse([sse(1, "add_message", user("Email Jo")), sse(2, "human_input_required", approvalRequest())]));
    const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
    expect(approval.actions).toEqual([
      { tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "jo@acme.example", subject: "March invoice", api_key: "sk-live-abcdefghijklmnopqrstuvwx" } },
    ]);
  });

  it("unwraps calls the way the gateway's route() does, and leaves what it couldn't run unnamed", () => {
    const request = (name: string, args: unknown) => ({ action_requests: [{ name, args }] });
    const take = (tool_name: unknown, args: unknown) => request("take_action", { tool_name, arguments: args, summary: "x" });
    // A bare slug, with JSON-text arguments.
    expect(approvalActions(take("GMAIL_SEND_EMAIL", '{"recipient_email":"jo@acme.example"}'))).toEqual([{ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "jo@acme.example" } }]);
    // Nested execute_tool, three deep.
    const nested = take("execute_tool", { tool_name: "execute_tool", arguments: JSON.stringify({ tool_name: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "t" } }) });
    expect(approvalActions(nested)).toEqual([{ tool: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "t" } }]);
    // Every tool of a multi-execute, not just the first; slugs as Composio reads them.
    const multi = take("composio_multi_execute_tool", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }, { tool_slug: "stripe_create_refund", arguments: "{}" }] });
    expect(approvalActions(multi)).toEqual([
      { tool: "GMAIL_SEND_EMAIL", arguments: {} },
      { tool: "STRIPE_CREATE_REFUND", arguments: {} },
    ]);
    // Anything else is itself; what can't be read is nameless; several requests are all of them.
    expect(approvalActions(take("act", { action: "click buy" }))).toEqual([{ tool: "act", arguments: { action: "click buy" } }]);
    expect(approvalActions(take("GMAIL_SEND_EMAIL", "{not json"))).toEqual([{ tool: "", arguments: null }]);
    expect(approvalActions(take("composio_multi_execute_tool", { tools: "x" }))).toEqual([{ tool: "", arguments: null }]);
    expect(approvalActions(request("some_other_tool", { a: 1 }))).toEqual([{ tool: "some_other_tool", arguments: { a: 1 } }]);
    expect(approvalActions({ action_requests: [take("GMAIL_SEND_EMAIL", {}).action_requests[0], take("GMAIL_SEND_EMAIL", {}).action_requests[0]] })).toHaveLength(2);
    expect(approvalActions(null)).toEqual([]);
  });

  it("continues a paused job with the decision and reads on from the last event", async () => {
    const state = { jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "12" };
    const { events, calls, error } = await run(
      base,
      streamResponse([sse(13, "token", { chunk: "Sent it to Jo and filed the thread under Invoices." }), sse(14, "end", { build_duration: 1 })]),
      input(tenantA, { resume: { decision: "approve", state } }),
      { [`/workflows/${JOB}/resume`]: () => Response.json({ job_id: JOB, status: "resuming" }) },
    );
    expect(error).toBeUndefined();
    const resume = calls.find((c) => c.url.endsWith(`/api/v2/workflows/${JOB}/resume`));
    expect(JSON.parse(resume!.init.body as string)).toEqual({ request_id: "Agent-1:job:nonce", decision: { action_id: "approve" } });
    expect(calls.some((c) => c.url.endsWith("/api/v2/workflows"))).toBe(false);
    const read = calls.find((c) => c.url.endsWith("/events"));
    expect((read!.init.headers as Record<string, string>)["Last-Event-ID"]).toBe("12");
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toContain("Sent it to Jo");
    // The resumed job is the same run, so the reply keeps the same trace.
    expect(events.filter((e) => e.type === "trace")).toEqual([{ type: "trace", traceId: JOB }]);
  });

  it("says the reply was lost when the job is gone after the stream drops", async () => {
    let reads = 0;
    const { error } = await run(base, streamResponse([sse(1, "add_message", user("Hi"))]), input(tenantA), {
      [`/workflows/${JOB}/events`]: () => (++reads === 1 ? streamResponse([sse(1, "add_message", user("Hi"))]) : Response.json({ detail: "Job not found" }, { status: 404 })),
    });
    expect(reads).toBe(2);
    expect((error as Error).message).toMatch(/restarted partway through/);
    expect((error as AgentError).retryable).toBe(true);
  });

  describe("the step a run paused on", () => {
    // Recorded shape: the paused message holds hidden discovery calls, then take_action with no
    // output. The resumed job reports the approved call again in a new bot message.
    const discover = { type: "tool_use", name: "discover_tools", tool_input: { query: "gmail" }, output: { content: "[]" }, error: null };
    const connect = { tool_name: "composio_manage_connections", arguments: { toolkits: ["gmail"] }, summary: "Connect Gmail" };
    const pausedCall = { type: "tool_use", name: "take_action", tool_input: connect, output: null, error: null };
    // While it streams, Langflow reports the paused call under the other gateway name.
    const streamedCall = { ...pausedCall, name: "execute_tool" };
    const link = { type: "tool", tool_call_id: "c", content: JSON.stringify({ successful: true, data: { results: { gmail: { redirect_url: "https://connect.composio.dev/link/g1" } } } }) };
    const approvedCall = { ...pausedCall, output: "ok" };
    const innerCall = { type: "tool_use", name: "composio_manage_connections", tool_input: { toolkits: ["gmail"] }, output: link, error: null };
    const connectRequest = { ...approvalRequest(), action_requests: [{ name: "take_action", args: connect }] };
    const steps = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "activity" }> => e.type === "activity");

    it("remembers which step the run paused on", async () => {
      const { events } = await run(
        base,
        streamResponse([sse(1, "add_message", bot("", [discover, discover, streamedCall], "msg-1")), sse(2, "human_input_required", connectRequest)]),
      );
      expect(steps(events).at(-1)).toMatchObject({ id: "msg-1:2", status: "running" });
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect(approval.state).toEqual({ jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } });
    });

    it("has no step to settle when the paused call wasn't reported before the pause", async () => {
      const status = { type: "tool_use", name: "take_action", tool_input: connect, output: "ok", error: null };
      const { events } = await run(base, streamResponse([sse(1, "add_message", bot("", [discover, status], "msg-1")), sse(2, "human_input_required", connectRequest)]));
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect((approval.state as { step?: unknown }).step).toBeUndefined();
    });

    it("settles that step with the resumed call instead of adding another", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const search = { type: "tool_use", name: "search", tool_input: { query: "q" }, output: { results: [] }, error: null };
      const { events, error } = await run(
        base,
        streamResponse([
          sse(3, "add_message", bot("", [pausedCall], "msg-2")),
          sse(4, "add_message", bot("", [approvedCall, innerCall], "msg-2")),
          sse(5, "add_message", bot("Here's the link.", [approvedCall, innerCall, search], "msg-2")),
          sse(6, "end", end("Here's the link.")),
        ]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect(error).toBeUndefined();
      const ids = new Set(steps(events).map((s) => s.id));
      expect([...ids]).toEqual(["msg-1:2", "msg-2:2"]);
      expect(steps(events).filter((s) => s.id === "msg-1:2").at(-1)).toMatchObject({ status: "done" });
    });

    it("settles it as failed when the resumed call fails", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const failed = { ...pausedCall, output: "Tool composio_manage_connections failed: 503 Service Unavailable" };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("Couldn't connect.", [failed], "msg-2")), sse(4, "end", end("Couldn't connect."))]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect(steps(events).map((s) => s.id)).toEqual(["msg-1:2"]);
      expect(steps(events)[0]).toMatchObject({ status: "failed" });
    });

    it("leaves step ids alone when the resumed job continues the same message", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("Done.", [discover, discover, approvedCall, innerCall], "msg-1")), sse(4, "end", end("Done."))]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect([...new Set(steps(events).map((s) => s.id))]).toEqual(["msg-1:0", "msg-1:1", "msg-1:2"]);
      expect(steps(events).at(-1)).toMatchObject({ id: "msg-1:2", status: "done" });
    });

    it("points a second pause at its own call, not the one already settled", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const next = { ...pausedCall, tool_input: { ...connect, arguments: { toolkits: ["googlesheets"] } } };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("", [approvedCall, innerCall, next], "msg-2")), sse(4, "human_input_required", connectRequest)]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect((approval.state as { step: unknown }).step).toEqual({ id: "msg-2:2", messageKey: "msg-2", tool: "composio_manage_connections" });
    });
  });

  it("tells the agent a decline was the owner's choice", async () => {
    const state = { jobId: JOB, requestId: "r", lastEventId: null };
    const { calls } = await run(base, streamResponse([sse(1, "end", {})]), input(tenantA, { resume: { decision: "reject", state } }), {
      "/resume": () => Response.json({ status: "resuming" }),
    });
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/resume"))!.init.body as string);
    expect(body.decision).toMatchObject({ action_id: "reject", values: { message: expect.stringMatching(/declined/) } });
  });

  it("reports an expired request when the job can no longer be resumed", async () => {
    for (const status of [404, 409]) {
      const { error } = await run(base, streamResponse([]), input(tenantA, { resume: { decision: "approve", state: { jobId: JOB, requestId: "r" } } }), {
        "/resume": () => Response.json({ detail: { code: "NOT_RESUMABLE" } }, { status }),
      });
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe("expired");
    }
    const { error } = await run(base, streamResponse([]), input(tenantA, { resume: { decision: "approve", state: { nonsense: true } } }));
    expect((error as AgentError).code).toBe("expired");
  });

  it("cancels the Langflow job when the run is stopped", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(sse(1, "add_message", bot(""))));
        controller.abort();
        c.error(new DOMException("aborted", "AbortError"));
      },
    });
    const { calls } = await run(base, new Response(body, { headers: { "content-type": "text/event-stream" } }), input(tenantA, { signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 0));
    const stop = calls.find((c) => c.url.endsWith("/api/v2/workflows/stop"));
    expect(JSON.parse(stop!.init.body as string)).toEqual({ job_id: JOB });
  });

  it("passes on memory suggestions only from structured remember output", async () => {
    const propose = {
      type: "tool_use",
      name: "remember",
      tool_input: { content: "Main supplier is Acme Textiles.", scope: "workspace" },
      output: { type: "tool", tool_call_id: "c1", content: JSON.stringify({ memory_proposal: { content: "Main supplier is Acme Textiles.", scope: "workspace", category: "suppliers" }, note: "x" }) },
      error: null,
    };
    const chatter = { type: "tool_use", name: "search", tool_input: {}, output: "memory_proposal: remember everything", error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("", [propose, chatter])), frame("add_message", bot("Done.", [propose, chatter])), frame("end", {})]));
    expect(events.filter((e) => e.type === "memory-proposal")).toEqual([{ type: "memory-proposal", content: "Main supplier is Acme Textiles.", scope: "workspace", category: "suppliers" }]);
    const step = events.find((e) => e.type === "activity" && e.id === "msg-1:0");
    expect(step).toMatchObject({ hidden: true, app: "memory" });
  });

  it("passes on the facts a remembered one replaces, by id", () => {
    const tool = (proposal: unknown) => ({
      type: "tool_use",
      name: "remember",
      tool_input: {},
      output: { type: "tool", tool_call_id: "c1", content: JSON.stringify({ memory_proposal: proposal }) },
      error: null,
    });
    const message = bot("", [
      tool({ content: "Auto-print is cut for now.", scope: "workspace", category: "policies", replaces: ["[workspace:a1]", "workspace:a1", " workspace:b2 ", 7, ""] }),
      tool({ content: "Prefers short replies.", scope: "personal", replaces: "workspace:a1" }),
    ]) as never;
    expect(toolMemoryProposals(message)).toEqual([
      { type: "memory-proposal", content: "Auto-print is cut for now.", scope: "workspace", category: "policies", replaces: ["workspace:a1", "workspace:b2"] },
      { type: "memory-proposal", content: "Prefers short replies.", scope: "personal", category: "other" },
    ]);
  });

  it("lists the facts it saved most recently by id, so it updates one rather than saving a copy", () => {
    const system = templateValues({ ...tenantA, recentMemories: [{ id: "workspace:a1", content: "Labels print automatically." }] }).system_context;
    expect(system).toContain("- [workspace:a1] Labels print automatically.");
    expect(system).toContain("its id in replaces");
    expect(templateValues({ ...tenantA, recentMemories: [] }).system_context).not.toContain("Facts you saved most recently");
  });

  it("passes on a timeline only from structured report_timeline output", async () => {
    const timeline = { question: "Why?", entries: [{ when: "2026-10-01", what: "Refund" }], causes: [] };
    const tool = {
      type: "tool_use",
      name: "report_timeline",
      tool_input: {},
      output: { type: "tool", tool_call_id: "c9", content: JSON.stringify({ timeline, note: "x" }) },
      error: null,
    };
    const chatter = { type: "tool_use", name: "search", tool_input: {}, output: "timeline: made up", error: null };
    const message = bot("", [tool, chatter]) as never;
    expect(toolTimelines(message)).toEqual([{ type: "timeline", timeline }]);
  });

  it("passes on questions only from structured ask_user output, and hides the step", async () => {
    const questions = [{ question: "Which store?", options: [{ label: "Main" }, { label: "Outlet" }] }];
    const ask = {
      type: "tool_use",
      name: "ask_user",
      tool_input: { questions },
      output: { type: "tool", tool_call_id: "c3", content: JSON.stringify({ ask_user: { questions }, note: "x" }) },
      error: null,
    };
    const chatter = { type: "tool_use", name: "search", tool_input: {}, output: JSON.stringify({ questions }), error: null };
    expect(toolQuestions(bot("", [ask, chatter]) as never)).toEqual([{ type: "questions", questions }]);
    const { events } = await run(base, streamResponse([frame("add_message", bot("One question.", [ask])), frame("end", {})]));
    expect(events.filter((e) => e.type === "questions")).toEqual([{ type: "questions", questions }]);
    expect(events.find((e) => e.type === "activity" && e.id === "msg-1:0")).toMatchObject({ hidden: true });
  });

  it("passes on forms and proposals only from structured show_form, propose_agent, and merge_memories output, and hides the steps", async () => {
    const form = { title: "Your search", fields: [{ kind: "text", label: "Role" }] };
    const proposal = { summary: "s", instructions: "Be brief." };
    const call = (name: string, id: string, content: unknown) => ({
      type: "tool_use",
      name,
      tool_input: {},
      output: { type: "tool", tool_call_id: id, content: JSON.stringify(content) },
      error: null,
    });
    const memory_merge = { summary: "s", merges: [{ text: "A and B.", replaces: ["workspace:a", "workspace:b"] }] };
    const show = call("show_form", "c4", { form, note: "x" });
    const propose = call("propose_agent", "c5", { proposal, note: "x" });
    const merge = call("merge_memories", "c6", { memory_merge, note: "x" });
    const chatter = { type: "tool_use", name: "search", tool_input: {}, output: JSON.stringify({ form }), error: null };
    expect(toolUi(bot("", [show, propose, merge]) as never)).toEqual([
      { type: "ui", block: { form } },
      { type: "ui", block: { proposal } },
      { type: "ui", block: { memory_merge } },
    ]);
    expect(toolUi(bot("", [{ ...show, error: "boom" }]) as never)).toEqual([]);
    const { events } = await run(base, streamResponse([frame("add_message", bot("A few things.", [show, chatter])), frame("end", {})]));
    expect(events.filter((e) => e.type === "ui")).toHaveLength(1);
    expect(events.find((e) => e.type === "activity" && e.id === "msg-1:0")).toMatchObject({ hidden: true });
  });

  it("passes on an offer to call from offer_call's structured output, keeps the reply before it, and hides the step", async () => {
    const offer_call = { reason: "This one's worth five minutes.", topic: "Which offer" };
    const offer = {
      type: "tool_use",
      name: "offer_call",
      tool_input: { reason: offer_call.reason },
      output: { type: "tool", tool_call_id: "c7", content: JSON.stringify({ offer_call, note: "x" }) },
      error: null,
    };
    expect(toolUi(bot("", [offer]) as never)).toEqual([{ type: "ui", block: { offer_call } }]);
    // "Not shown: …" is plain text, never a card.
    expect(toolUi(bot("", [{ ...offer, output: { type: "tool", tool_call_id: "c7", content: "Not shown: an offer needs one sentence on why a call would help." } }]) as never)).toEqual([]);
    const answer = "There are three trade-offs: pay, growth, and the commute.";
    const { events } = await run(base, streamResponse([frame("add_message", bot(answer, [offer])), frame("end", {})]));
    expect(events.filter((e) => e.type === "ui")).toEqual([{ type: "ui", block: { offer_call } }]);
    expect(events.find((e) => e.type === "activity" && e.id === "msg-1:0")).toMatchObject({ label: "Offered a call", hidden: true });
    // The text before it is the reply, not an opening line.
    expect(events.filter((e) => e.type === "note")).toEqual([]);
  });

  it("hands the member the browser only from hand_browser itself", () => {
    const hand_browser = { reason: "Sign in to your USPS account.", site: "USPS" };
    const handoff = {
      type: "tool_use",
      name: "hand_browser",
      tool_input: hand_browser,
      output: { type: "tool", tool_call_id: "c8", content: JSON.stringify({ hand_browser, note: "x" }) },
      error: null,
    };
    expect(toolUi(bot("", [handoff]) as never)).toEqual([{ type: "ui", block: { hand_browser } }]);
    // A page the agent read that happens to look like one is never a card.
    expect(toolUi(bot("", [{ ...handoff, name: "extract" }]) as never)).toEqual([]);
    expect(toolUi(bot("", [{ ...handoff, output: { type: "tool", tool_call_id: "c8", content: "Not shown: say in one sentence what they need to do in the browser." } }]) as never)).toEqual([]);
  });

  it("sends the person's saved sign-ins for the browser, or nothing", () => {
    expect(templateValues({ ...tenantA, browserContext: "ctx_0123456789abcdef" }).browser_context).toBe("ctx_0123456789abcdef");
    expect(templateValues(tenantA).browser_context).toBe("");
  });

  it("says calls are available only where the member could take one", () => {
    // The fact alone, in the words the instructions key on; no tool named, for a flow from before offer_call.
    expect(templateValues({ ...tenantA, calls: true }).system_context).toContain("can also talk this through with you on a call");
    expect(templateValues({ ...tenantA, calls: true }).system_context).not.toContain("offer_call");
    expect(templateValues(tenantA).system_context).not.toContain("talk this through");
  });

  it("passes on a memory suggestion that only arrives in the job's result message", async () => {
    const propose = {
      type: "tool_use",
      name: "remember",
      tool_input: { content: "Ships orders on Tuesdays.", scope: "workspace" },
      output: { type: "tool", tool_call_id: "c1", content: JSON.stringify({ memory_proposal: { content: "Ships orders on Tuesdays.", scope: "workspace" } }) },
      error: null,
    };
    const result = { outputs: [{ outputs: [{ results: { message: bot("Noted.", [propose]) } }] }] };
    const { events } = await run(base, streamResponse([frame("add_message", bot("Noted.", [propose])), frame("end", { result })]));
    expect(events.filter((e) => e.type === "memory-proposal")).toEqual([{ type: "memory-proposal", content: "Ships orders on Tuesdays.", scope: "workspace", category: "other" }]);
    const late = await run(base, streamResponse([frame("end", { result })]));
    expect(late.events.filter((e) => e.type === "memory-proposal")).toHaveLength(1);
  });

  it("shows an approved action as the real step it ran, not as the gateway", async () => {
    const take = { type: "tool_use", name: "take_action", tool_input: { tool_name: "load_skill", arguments: { skill_name: "data-tasks" }, summary: "Load it" }, output: { type: "tool", tool_call_id: "c", content: "{}" }, error: null };
    const inner = { type: "tool_use", name: "load_skill", tool_input: { skill_name: "data-tasks" }, output: { value: {} }, error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("ok", [take, inner])), frame("end", {})]));
    const steps = events.filter((e) => e.type === "activity") as Extract<AgentEvent, { type: "activity" }>[];
    expect(new Set(steps.map((s) => s.id))).toEqual(new Set(["msg-1:0"]));
    expect(steps[0]).toMatchObject({ label: "Checked a playbook" });
  });
});

describe("Langflow attachments", () => {
  const file = { id: "a1", name: "Q3 orders.csv", mimeType: "text/csv", size: 12, read: async () => new Blob(["sku,qty\nA,1"]) };
  const withFiles = { ...base, tweaks: { "ChatInput-1": { files: "{{files}}" } } };

  it("uploads each file under a random name and hands Langflow the paths", async () => {
    const uploaded: string[] = [];
    const { calls, error } = await run(withFiles, streamResponse([frame("add_message", bot("Read it.")), frame("end", {})]), input(tenantA, { attachments: [file] }), {
      "/api/v2/files": () => {
        uploaded.push("x");
        return Response.json({ path: "user-1/9f-Q3_orders.csv" });
      },
    });
    expect(error).toBeUndefined();
    const upload = calls.find((c) => c.url.endsWith("/api/v2/files"))!;
    const form = upload.init.body as FormData;
    const sent = form.get("file") as File;
    expect(sent.name).toMatch(/^[0-9a-f-]{36}-Q3_orders\.csv$/);
    expect(await sent.text()).toBe("sku,qty\nA,1");
    const start = JSON.parse(calls.find((c) => c.url.endsWith("/api/v2/workflows"))!.init.body as string);
    expect(start.tweaks).toEqual({ "ChatInput-1": { files: ["user-1/9f-Q3_orders.csv"] } });
    expect(uploaded).toHaveLength(1);
  });

  it("says files aren't supported when the flow has no place for them", async () => {
    const adapter = createLangflowAdapter(base);
    expect(adapter.capabilities.attachments).toBe(false);
    const { error, calls } = await run(base, streamResponse([]), input(tenantA, { attachments: [file] }));
    expect((error as Error).message).toMatch(/can't read attached files/);
    expect(calls).toHaveLength(0);
    expect(createLangflowAdapter(withFiles).capabilities.attachments).toBe(true);
  });
});

describe("Langflow run that stops on a held call", () => {
  const sse = (id: number, event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\nid: ${id}\n\n`;
  const HOLD = "Running code needs the owner's approval every time, even just to read. Call take_action now with the same tool_name and arguments plus a one-sentence summary; don't reply first.";
  const read = { tool_name: "composio_remote_bash_tool", arguments: { command: "python3 -c 'print(open(\"/tmp/t.txt\").read())'" } };
  // As recorded: an opening line, the held call, and the same line again, then the run ended.
  const heldCall = { type: "tool_use", name: "execute_tool", tool_input: read, output: { content: HOLD, tool_call_id: "t1", status: "success" } };
  const stopped = bot("Now I'll read it so I can summarize it.", [{ type: "text", text: "Now I'll read it so I can summarize it." }, heldCall, { type: "text", text: "Now I'll read it so I can summarize it." }]);
  const JOB2 = "4b7c0d1e-0000-4000-8000-000000000002";

  it("tells which runs stopped short on a hold", () => {
    expect(endedOnHold(stopped)).toBe(true);
    const asked = bot("", [heldCall, { type: "tool_use", name: "take_action", tool_input: { ...read, summary: "Read it" }, output: null }]);
    expect(endedOnHold(asked)).toBe(false);
    const explained = bot("", [heldCall, { type: "text", text: "That needs your OK first.\n\nI'd rather not run code for this, so here's the summary from the captions I already have: ..." }]);
    expect(endedOnHold(explained)).toBe(false);
    expect(endedOnHold(bot("Done.", [{ type: "tool_use", name: "search", tool_input: {}, output: "results" }]))).toBe(false);
  });

  it("sends the agent on once, in the same session and reply, so the member gets the approval card", async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    let started = 0;
    const adapter = createLangflowAdapter({
      ...base,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
        if (url.endsWith("/api/v2/workflows")) return Response.json({ job_id: started++ === 0 ? JOB : JOB2, status: "queued" });
        if (url.endsWith(`/api/v2/workflows/${JOB}/events`)) {
          return streamResponse([sse(1, "add_message", user("just do it")), sse(2, "add_message", stopped), sse(3, "end", end("Now I'll read it so I can summarize it."))]);
        }
        if (url.endsWith(`/api/v2/workflows/${JOB2}/events`)) {
          return streamResponse([sse(1, "add_message", user(HOLD_NUDGE)), sse(2, "human_input_required", approvalRequest("Agent-1:job2:nonce"))]);
        }
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run(input(tenantA))) events.push(e);

    const starts = calls.filter((c) => c.url.endsWith("/api/v2/workflows"));
    expect(starts).toHaveLength(2);
    expect(starts[1].body).toMatchObject({ input_value: HOLD_NUDGE, session_id: starts[0].body!.session_id });
    // The second job's events are read fresh, not from the first job's position.
    const second = calls.find((c) => c.url.endsWith(`/${JOB2}/events`));
    expect(second).toBeDefined();
    const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
    expect(approval.state).toEqual({ jobId: JOB2, requestId: "Agent-1:job2:nonce", lastEventId: "2" });
    // What it said before stopping reads as the opening of the work, not as its reply.
    expect(events.filter((e) => ["message", "note", "text-delta", "note-reply"].includes(e.type))).toEqual([{ type: "note", text: "Now I'll read it so I can summarize it." }]);
    expect(events.at(-1)?.type).toBe("approval");
  });

  it("sends it on only once", async () => {
    let started = 0;
    const adapter = createLangflowAdapter({
      ...base,
      fetch: (async (url: string) => {
        if (url.endsWith("/api/v2/workflows")) return Response.json({ job_id: started++ === 0 ? JOB : JOB2, status: "queued" });
        if (url.includes("/events")) return streamResponse([sse(1, "add_message", stopped), sse(2, "end", end("Now I'll read it so I can summarize it."))]);
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run(input(tenantA))) events.push(e);
    expect(started).toBe(2);
  });
});

describe("Langflow rewind", () => {
  it("drops the latest exchange from the session's stored memory", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createLangflowAdapter({
      ...base,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (!init.method || init.method === "GET") {
          return Response.json([
            { id: "u1", sender: "User" },
            { id: "b1", sender: "Machine" },
            { id: "u2", sender: "User" },
            { id: "card", sender: "Machine" },
            { id: "b2", sender: "Machine" },
            // The app's nudge after a run stopped on a held call is part of the same turn.
            { id: "nudge", sender: "User", text: HOLD_NUDGE },
            { id: "b3", sender: "Machine" },
          ]);
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await adapter.rewind!({ tenant: tenantA, conversationId: "c0ffee00-0000-4000-8000-000000000000", threadId: null }, 1);
    const list = new URL(calls[0].url);
    expect(list.pathname).toBe("/api/v1/monitor/messages");
    expect(list.searchParams.get("session_id")).toBe(langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000"));
    expect(list.searchParams.get("flow_id")).toBe("flow-1");
    expect(calls[1].init.method).toBe("DELETE");
    expect(JSON.parse(calls[1].init.body as string)).toEqual(["u2", "card", "b2", "nudge", "b3"]);
  });

  it("erases the whole stored conversation when a chat is deleted", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createLangflowAdapter({
      ...base,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (!init.method || init.method === "GET") {
          return Response.json(calls.length === 1 ? [{ id: "u1", sender: "User" }, { id: "b1", sender: "Machine" }] : []);
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await adapter.forget!({ tenant: tenantA, conversationId: "c0ffee00-0000-4000-8000-000000000000" });
    expect(new URL(calls[0].url).searchParams.get("session_id")).toBe(langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000"));
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe("DELETE");
    expect(JSON.parse(calls[1].init.body as string)).toEqual(["u1", "b1"]);
  });

  it("doesn't claim rewind when Langflow scopes memory by end user", () => {
    expect(createLangflowAdapter({ ...base, endUserHeader: "X-End-User" }).capabilities.rewind).toBe(false);
  });
});


describe("toolBrowserSessions", () => {
  const mcp = (payload: unknown) => ({ meta: null, content: [{ type: "text", text: JSON.stringify(payload), annotations: null, meta: null }], structuredContent: null, isError: false });
  const use = (name: string, output: unknown, error: unknown = null) => ({ type: "tool_use", name, tool_input: {}, output, error });
  const S1 = "33333333-3333-4333-8333-333333333333";
  const S2 = "44444444-4444-4444-8444-444444444444";
  it("reports the browser Studio Browser tagged its results with, last one wins", () => {
    const message = bot("", [use("start", mcp({ success: true, data: { sessionId: S1, available: true } })), use("extract", mcp({ studioBrowserSession: S2, success: true, data: {} }))]);
    expect(toolBrowserSessions(message as never)).toEqual([{ type: "browser-session", sessionId: S2 }]);
  });
  it("reports an ended browser, and ignores failures and other tools", () => {
    expect(toolBrowserSessions(bot("", [use("navigate", mcp({ studioBrowserSession: S1 })), use("end", mcp({ success: true }))]) as never)).toEqual([{ type: "browser-session", sessionId: null }]);
    expect(toolBrowserSessions(bot("", [use("navigate", null, "boom"), use("search", mcp({ studioBrowserSession: S1 }))]) as never)).toEqual([]);
  });
});
