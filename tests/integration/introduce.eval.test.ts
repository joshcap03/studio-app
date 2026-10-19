import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { buildUiBlock } from "@/lib/chat/ui";
import { companionName } from "@/lib/companion";
import { introduceSkill } from "@/lib/skills/introduce";
import { renderSkillMessage } from "@/lib/skills/render";
import type { AgentProposal } from "@/lib/types";
import { liveFlow, replyOf } from "./setup-harness";

// "Say hello" on a live flow with a real model (LANGFLOW_TEST_* env; point it at a test flow,
// never the live one). Once an agent knows its member, its introduction must be short, true to
// what it was told (never invented), within the member's own rules, and end with a name for
// itself on the proposal card and nothing else. Its manner, once kept, must not make replies
// longer. Made-up members only. INTRODUCE_EVAL_LOG writes the transcripts.

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};
const GAME = /\b(quests?|xp|streaks?|badges?|achievements?|unlock\w*|level(?:s|ed)? up|leaderboards?|confetti|hatch\w*|evolv\w*|sketch\w*)\b/i;
const log: Record<string, unknown>[] = [];

function tenantFor(over: Partial<AgentTenantContext> = {}): AgentTenantContext {
  return {
    workspaceId: crypto.randomUUID(),
    workspaceName: "Job search",
    userId: crypto.randomUUID(),
    composioUserId: `eval_${crypto.randomUUID()}`,
    account: { name: "Priya Natarajan", about: "Product designer, eight years in B2B tools." },
    composioToolkits: {},
    profile: "Help Priya find a staff product designer role.",
    agentInstructions: "",
    memories: [
      "Wants remote staff product designer roles, nothing below staff level.",
      "Passes on anything in ad-tech.",
      "Likes a short shortlist first, with the reasons after.",
      "Keeps Thursday mornings for portfolio reviews.",
    ],
    task: null,
    tracker: [],
    setup: null,
    notes: [],
    agentFiles: [],
    guardrail: null,
    self: { name: null, manner: null },
    ...over,
  };
}

async function run(tenant: AgentTenantContext, message: string, label: string) {
  const config: LangflowConfig = {
    baseUrl: process.env.LANGFLOW_TEST_BASE_URL!,
    apiKey: process.env.LANGFLOW_TEST_API_KEY!,
    flowId: process.env.LANGFLOW_TEST_FLOW_ID!,
    stream: true,
    tweaks: process.env.LANGFLOW_TEST_TWEAKS ? JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) : DEFAULT_TWEAKS,
  };
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId: crypto.randomUUID(),
    threadId: null,
    message,
    history: [],
    tenant,
    attachments: [],
    signal: AbortSignal.timeout(240_000),
  })) {
    events.push(e);
  }
  const proposals = events.flatMap((e) => (e.type === "ui" ? [buildUiBlock(e.block)] : [])).filter((b): b is AgentProposal => b?.kind === "proposal");
  const reply = replyOf(events);
  log.push({ label, reply, proposals });
  if (process.env.INTRODUCE_EVAL_LOG) writeFileSync(process.env.INTRODUCE_EVAL_LOG, JSON.stringify(log, null, 2));
  return { reply, proposal: proposals[0] ?? null, proposals };
}

const hello = (tenant: AgentTenantContext, voiceName: string | null = null, taken: string[] = []) =>
  renderSkillMessage(introduceSkill({ member: tenant.account!.name.split(" ")[0], voiceName, taken }), "");

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => /\w/.test(s)).length;

/** Only a name: no setup changes riding along with the introduction. */
function onlyIdentity(p: AgentProposal | null) {
  expect(p, "no proposal card").not.toBeNull();
  expect(companionName(p!.identity?.name)).toBeTruthy();
  expect(p!.profile ?? p!.instructions ?? null).toBeNull();
  expect([...p!.skills, ...p!.tasks, ...p!.memories]).toEqual([]);
}

describe.skipIf(!liveFlow)("introduce (live)", () => {
  it("introduces itself from what it knows, briefly, and suggests a name on the card", async () => {
    const tenant = tenantFor();
    const { reply, proposal } = await run(tenant, hello(tenant), "grounded");
    onlyIdentity(proposal);
    expect(proposal!.identity!.name.toLowerCase()).not.toBe("priya");
    expect(proposal!.identity!.manner.length).toBeGreaterThan(10);
    expect(sentences(reply)).toBeLessThanOrEqual(6);
    expect(reply).toMatch(/remote|ad-?tech|shortlist|reasons|portfolio|thursday|staff/i);
    expect(reply).not.toMatch(GAME);
    expect(reply).not.toMatch(/propose_agent|\bsetup\b/i);
  }, 300_000);

  it("offers to keep the name they've heard on calls, and avoids another agent's", async () => {
    const tenant = tenantFor();
    const { proposal } = await run(tenant, hello(tenant, "Rowan", ["June"]), "voice name");
    onlyIdentity(proposal);
    expect(proposal!.identity!.name).toBe("Rowan");
  }, 300_000);

  it("says it's still learning when it knows little, rather than inventing", async () => {
    const tenant = tenantFor({ memories: [], account: { name: "Priya Natarajan", about: "" }, profile: "" });
    const { reply, proposal } = await run(tenant, hello(tenant), "sparse");
    onlyIdentity(proposal);
    // Says plainly it doesn't know much yet, in its own words.
    expect(reply).toMatch(/still (learning|getting to know)|getting to know|learn (that|how|more|as we go)|not yet|only know|don't (yet )?know|so far/i);
    expect(reply).not.toMatch(/remote|ad-?tech|portfolio|thursday/i);
  }, 300_000);

  it("keeps to the member's own rules", async () => {
    const tenant = tenantFor({ guardrail: { instructions: "Never recommend anything or tell me what to do. Give me options and let me decide.", recentChats: [] } });
    const { reply, proposal } = await run(tenant, hello(tenant), "guardrail");
    onlyIdentity(proposal);
    expect(reply).not.toMatch(/\b(I recommend|you should|I'd suggest you)\b/i);
  }, 300_000);

  it("doesn't get longer once it has a manner", async () => {
    const ask = "In two or three sentences: what should I watch for in a staff designer job description?";
    const lengths = { plain: [] as number[], named: [] as number[] };
    for (let i = 0; i < 2; i++) {
      lengths.plain.push((await run(tenantFor({ self: { name: null, manner: null } }), ask, `plain ${i}`)).reply.length);
      lengths.named.push(
        (await run(tenantFor({ self: { name: "Juniper", manner: "I keep it short and lead with what I found. I say plainly when something misses your bar." } }), ask, `named ${i}`)).reply.length,
      );
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    log.push({ label: "lengths", lengths });
    if (process.env.INTRODUCE_EVAL_LOG) writeFileSync(process.env.INTRODUCE_EVAL_LOG, JSON.stringify(log, null, 2));
    expect(mean(lengths.named)).toBeLessThanOrEqual(mean(lengths.plain) * 1.25);
  }, 900_000);
});
