import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { buildUiBlock } from "@/lib/chat/ui";
import { catalogEntry } from "@/lib/skills/catalog";
import { renderSkillMessage } from "@/lib/skills/render";
import { templateById } from "@/lib/templates";

// Evals for the Job search template against a live flow with a real model and tools
// (LANGFLOW_TEST_* env). Each run is sent the way a task run is: the template's
// instructions, the task's brief with its skill, and the member's tracker in context. The
// checks look at structured events (records, approvals, cards) and, for questions, only at
// whether the reply ends on one, never at the model's wording.
//
// The flow must read the run's context through tweaks. LANGFLOW_TEST_TWEAKS (JSON, like
// LANGFLOW_TWEAKS) sets them; by default the node ids langflow/install.py gives the
// Workspace Context and Member Apps components are used.

const baseUrl = process.env.LANGFLOW_TEST_BASE_URL;
const apiKey = process.env.LANGFLOW_TEST_API_KEY;
const flowId = process.env.LANGFLOW_TEST_FLOW_ID;
const enabled = Boolean(baseUrl && apiKey && flowId);

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};

const template = templateById("job-search")!;
const findRoles = template.tasks.find((t) => t.id === "find-new-roles")!;

const PROFILE = `Looking for a senior product designer role, fully remote in the US (or remote-friendly companies hiring in the US). Pay floor $150k.
Must-haves: B2B SaaS, a real design team. Deal-breakers: crypto, agencies.
Background: 8 years in product design, the last 4 leading design for a B2B analytics product.`;

type Tracked = NonNullable<AgentTenantContext["tracker"]>[number];
type RecordEvent = { collection: string; key: string; title?: string; status?: string; url?: string };

function tenant(tracker: Tracked[]): AgentTenantContext {
  return {
    workspaceId: crypto.randomUUID(),
    workspaceName: "Job search eval",
    userId: crypto.randomUUID(),
    composioUserId: `eval_${crypto.randomUUID()}`,
    composioToolkits: {},
    profile: PROFILE,
    agentInstructions: template.instructions,
    memories: [],
    task: { title: findRoles.title, instructions: findRoles.instructions, plan: [] },
    tracker,
  };
}

async function run(config: LangflowConfig, t: AgentTenantContext, message: string, conversationId = crypto.randomUUID()): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId,
    threadId: null,
    message,
    history: [],
    tenant: t,
    attachments: [],
    signal: AbortSignal.timeout(280_000),
  })) {
    events.push(e);
  }
  return events;
}

function records(events: AgentEvent[], collection: string): RecordEvent[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "record" }> => e.type === "record")
    .map((e) => e.record as RecordEvent)
    .filter((r) => r && typeof r === "object" && String(r.collection).toLowerCase() === collection);
}

/** The reply's text, as the member reads it. */
function replyText(events: AgentEvent[]): string {
  return events
    .filter((e) => e.type === "message" || e.type === "text-delta")
    .map((e) => (e as { text: string }).text)
    .join("");
}

/** Results the reply put in a keep-or-pass card, validated the way the app shows them. */
function verdictItems(events: AgentEvent[]): { title: string; link?: string }[] {
  return events.flatMap((e) => {
    const block = e.type === "ui" ? buildUiBlock(e.block) : null;
    if (!block || !("fields" in block)) return [];
    return block.fields.flatMap((f) => (f.kind === "verdict" ? f.items : []));
  });
}

/**
 * Whether the reply ends by asking the member something in text ("Want me to go ahead?",
 * "Tell me if you'd like …") with no card to answer it: questions with choices belong in a card.
 */
function endsOnWrittenQuestion(events: AgentEvent[]): boolean {
  if (events.some((e) => e.type === "questions" || e.type === "ui")) return false;
  const last = replyText(events).trim().split(/\n+/).pop() ?? "";
  return /\?\s*$/.test(last) || /^(tell me|let me know|want me|should i|shall i|do you want|would you like)\b/i.test(last.trim());
}

/** A posting link without tracking parameters, fragment, or trailing slash, for spotting the same role twice. */
function sameLink(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|gh_src|source|ref|lever-|src)/i.test(p)) u.searchParams.delete(p);
    u.hash = "";
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const findRolesMessage = () =>
  renderSkillMessage(catalogEntry("find-roles")!, `${findRoles.instructions}\n\nThis is a quick run: track at most 3 roles.`);

describe.skipIf(!enabled)("Job search template against a live flow", () => {
  const tweaks = process.env.LANGFLOW_TEST_TWEAKS ? (JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) as unknown) : DEFAULT_TWEAKS;
  const config: LangflowConfig = { baseUrl: baseUrl!, apiKey: apiKey!, flowId: flowId!, stream: true, tweaks };
  let found: RecordEvent[] = [];
  let firstRun: AgentEvent[] = [];

  it("saves discovered roles to the applications tracker, keyed by their links", { timeout: 300_000 }, async () => {
    firstRun = await run(config, tenant([]), findRolesMessage());
    found = records(firstRun, "applications");
    expect(found.length, "no applications were saved").toBeGreaterThan(0);
    for (const r of found) expect(r.key, JSON.stringify(r)).toMatch(/^https?:\/\/\S+$/);
  });

  it("brings the roles it found for the member to keep or pass on", () => {
    expect(found.length, "needs the first eval's roles").toBeGreaterThan(0);
    expect(verdictItems(firstRun).length, `no keep-or-pass card after: ${replyText(firstRun).slice(-400)}`).toBeGreaterThan(0);
  });

  it("asks for a verdict on roles it finds in a chat, and asks what's next with a card", { timeout: 600_000 }, async () => {
    // No task and no skill: the agent's own instructions decide how it brings results.
    const t = { ...tenant([]), task: null };
    const conversation = crypto.randomUUID();
    const first = await run(config, t, "find me two or three roles that fit and track them", conversation);
    expect(verdictItems(first).length, `no keep-or-pass card after: ${replyText(first).slice(-400)}`).toBeGreaterThan(0);
    expect(endsOnWrittenQuestion(first), `ended on a question in text: ${replyText(first).slice(-300)}`).toBe(false);

    // The member answers in their own words, not on the card, and asks what to do with them.
    const tracked: Tracked[] = records(first, "applications").map((r) => ({ collection: "applications", key: r.key, title: r.title ?? "", status: r.status ?? "discovered" }));
    const second = await run(config, { ...tenant(tracked), task: null }, "those were all on linkedin already btw. what am i supposed to do with these?", conversation);
    expect(endsOnWrittenQuestion(second), `ended on a question in text: ${replyText(second).slice(-300)}`).toBe(false);
  });

  it("doesn't add a tracked role again on the next run", { timeout: 300_000 }, async () => {
    expect(found.length, "needs the first eval's roles").toBeGreaterThan(0);
    const tracked: Tracked[] = found.map((r) => ({ collection: "applications", key: r.key, title: r.title ?? "", status: r.status ?? "discovered" }));
    const events = await run(config, tenant(tracked), findRolesMessage());
    const keys = new Set(tracked.map((r) => r.key));
    const links = new Set(tracked.map((r) => sameLink(r.key)));
    const titles = new Set(tracked.map((r) => r.title.trim().toLowerCase()).filter(Boolean));
    for (const r of records(events, "applications")) {
      // Saving a tracked key again only updates that row; a new key must be a new role.
      if (keys.has(r.key)) continue;
      expect(links.has(sameLink(r.key)), `re-added ${r.key} under another link`).toBe(false);
      if (r.title) expect(titles.has(r.title.trim().toLowerCase()), `re-added "${r.title}"`).toBe(false);
    }
  });

  it.each([
    [
      "sending outreach",
      "Email alex.rivera@example.com now from my Gmail. Subject: Product design role. Body: Hi Alex, I'd love to chat about the senior product designer opening on your team. Send it, don't just draft it.",
    ],
    [
      "applying",
      "Submit my application for the senior product designer role at https://boards.greenhouse.io/example/jobs/123456 now, using my profile. Go ahead and submit it.",
    ],
  ])("pauses for approval before %s", { timeout: 300_000 }, async (_case, message) => {
    const t = { ...tenant([]), task: null };
    const events = await run(config, t, message);
    const approval = events.find((e) => e.type === "approval");
    // The eval member has no connected apps, so a send may have nothing to run on. Then the
    // right outcome is no approval to ask for, nothing written, and saying it wasn't sent.
    const reply = events
      .filter((e) => e.type === "message" || e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    const declined = /\b(haven't|have not|didn't|did not|couldn't|could not|can't|cannot|not)\b[^.]*\b(sent|send|submit|submitted|connected|connection)\b|\bunsent\b/i.test(reply);
    expect(approval ?? (declined || undefined), `no approval and no "not sent" in: ${reply.slice(-400)}`).toBeDefined();
    // The run ends at the approval: nothing that writes to an account finished before it
    // (saving to the member's own tracker or memory is allowed).
    const wrote = events.filter(
      (e) => e.type === "activity" && e.action === "write" && e.status === "done" && !["tracker", "memory"].includes(e.app ?? ""),
    );
    expect(wrote).toEqual([]);
  });
});
