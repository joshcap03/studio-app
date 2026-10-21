import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { claimAsAgentFile } from "@/lib/agent-files";
import { errorResponse, parseBody } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { proposalPicksSchema } from "@/lib/chat/ui";
import { nameCompanion, setCompanionSound } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { isSetupConversation, updateSetup } from "@/lib/setup-state";
import { memoryEnabled, remember } from "@/lib/memory";
import { MAX_MERGES, MAX_MERGE_TEXT, applyMerges, undoMerges } from "@/lib/memory-merge";
import { addFromCatalog, createSkill, listSkills } from "@/lib/skills";
import { createTask, getTaskForConversation, listTasks, updateTask } from "@/lib/tasks";
import { timezoneSchema } from "@/lib/tasks/schema";
import { authorizeTenant, jsonError, type Tenant } from "@/lib/tenant";
import { MAX_CONTEXT_LENGTH, MAX_FORM_FIELDS, MAX_FORM_FILES, MAX_VERDICT_ITEMS, type AgentProposal, type ProposalPicks, type UiResponse } from "@/lib/types";
import { firstName } from "@/lib/setup-words";
import { saveVerdicts } from "@/lib/verdicts";
import { openCall } from "@/lib/voice/calls";
import { voiceStatus } from "@/lib/voice/status";
import type { VoiceKey } from "@/lib/voice/voices";
import { updateSettings } from "@/lib/workspace";

type Context = { params: Promise<{ id: string; blockId: string }> };

const body = z.discriminatedUnion("action", [
  // The member is sending a form's answers (as their next message): this marks the form
  // answered and first moves the uploads from its "keep" file fields onto the agent's shelf.
  // Its verdict fields' keep/pass calls are saved too, against the items the stored card holds.
  z.strictObject({
    action: z.literal("submit"),
    keepFiles: z.array(z.uuid()).max(MAX_FORM_FILES).optional(),
    verdicts: z
      .array(
        z.strictObject({
          fieldId: z.string().min(1).max(48),
          itemId: z.string().min(1).max(48),
          verdict: z.enum(["keep", "pass"]),
          reason: z.string().max(200).optional(),
        }),
      )
      .max(MAX_FORM_FIELDS * MAX_VERDICT_ITEMS)
      .optional(),
  }),
  // The member applied some or all of a proposed setup, with their own edits to its texts.
  z.strictObject({
    action: z.literal("apply"),
    picks: proposalPicksSchema,
    edits: z
      .strictObject({
        profile: z.string().max(MAX_CONTEXT_LENGTH).optional(),
        instructions: z.string().max(MAX_CONTEXT_LENGTH).optional(),
        // The name the member chose for the agent, when it isn't the one it suggested.
        name: z.string().max(80).optional(),
      })
      .optional(),
    timezone: timezoneSchema.optional(),
  }),
  // The member made some or all of a proposed merge of remembered facts, with their own edits
  // to the merged texts (by the merge's place in the card).
  z.strictObject({
    action: z.literal("merge"),
    picks: z.array(z.number().int().min(0).max(MAX_MERGES - 1)).min(1).max(MAX_MERGES),
    edits: z.record(z.string().regex(/^\d{1,2}$/), z.string().trim().min(1).max(MAX_MERGE_TEXT)).optional(),
  }),
  // The member took back the merges they made from this card.
  z.strictObject({ action: z.literal("undo") }),
  // The member took the agent's offer to talk on a call: the call they started from it, which
  // must be their own and still going (it starts first, so a refused call leaves the offer open).
  z.strictObject({ action: z.literal("accept"), sessionId: z.uuid() }),
  // The member said Not now to the offer: the agent doesn't offer again in this conversation.
  z.strictObject({ action: z.literal("decline") }),
  // The member handed the agent's browser back after taking it over (their "done" goes out as
  // their next message).
  z.strictObject({ action: z.literal("handback") }),
]);

/**
 * Answers a card the agent showed under one of the caller's replies. What gets applied is the
 * stored proposal (plus the member's own edits to its texts), never items from the request; a
 * merge is undone from what the stored response says it did.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid(), blockId: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "That card wasn't found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const store = storeFor(auth.value);
    const messages = await store.listMessages(ids.data.id);
    const message = messages.find((m) => m.ui?.some((b) => b.id === ids.data.blockId));
    const block = message?.ui?.find((b) => b.id === ids.data.blockId);
    if (!message || !block) return jsonError(404, "That card wasn't found.");
    const previous = message.uiResponse?.[block.id];

    let response: UiResponse;
    if (input.action === "submit") {
      if (block.kind !== "form") return jsonError(400, "Only a form can be sent.");
      const keep = [...new Set(input.keepFiles ?? [])];
      if (keep.length && !block.fields.some((f) => f.kind === "file" && f.keep)) return jsonError(400, "This form doesn't keep files.");
      if (previous) return jsonError(409, "You already sent this.");
      // Only the caller's own unsent uploads can move (claim_agent_file checks).
      for (const id of keep) {
        if (!(await claimAsAgentFile(auth.value, id))) return jsonError(404, "That file wasn't found. Upload it again.");
      }
      if (input.verdicts?.length) {
        // The answer still goes out if the verdicts can't be saved; only the score misses them.
        try {
          const task = await getTaskForConversation(auth.value, ids.data.id);
          await saveVerdicts(auth.value, block, { messageId: message.id, taskId: task?.id ?? null }, input.verdicts);
        } catch (error) {
          console.error("[ui] couldn't save verdicts", error);
        }
      }
      response = { status: "submitted", at: Date.now() };
    } else if (input.action === "merge") {
      if (block.kind !== "memory-merge") return jsonError(400, "Only proposed merges can be made.");
      if (previous) return jsonError(409, "These were already merged.");
      if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
      const result = await applyMerges(auth.value, block, input.picks, input.edits ?? {});
      // Nothing saved, so a second click racing the first can't overwrite what it did.
      if (result.merges.length === 0) return jsonError(409, "Those facts have changed since, so nothing was merged. Ask for a fresh tidy-up.");
      response = { status: "merged", at: Date.now(), ...result };
    } else if (input.action === "undo") {
      if (block.kind !== "memory-merge" || previous?.status !== "merged") return jsonError(409, "There's nothing to undo here.");
      if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
      response = { status: "undone", at: Date.now(), ...(await undoMerges(auth.value, previous)) };
    } else if (input.action === "handback") {
      if (block.kind !== "browser") return jsonError(400, "Only the browser can be handed back.");
      if (previous) return jsonError(409, "You already handed it back.");
      response = { status: "handed-back", at: Date.now() };
    } else if (input.action === "accept" || input.action === "decline") {
      if (block.kind !== "offer") return jsonError(400, "Only an offer to call can be taken.");
      if (previous) return jsonError(409, "You already answered this.");
      if (input.action === "accept") {
        // Only a call that's really going, and the caller's own, counts as taking it.
        if (!voiceStatus(auth.value) || !(await openCall(auth.value, input.sessionId))) return jsonError(404, "That call wasn't found.");
        response = { status: "accepted", at: Date.now(), sessionId: input.sessionId };
      } else {
        response = { status: "declined", at: Date.now() };
      }
    } else {
      if (block.kind !== "proposal") return jsonError(400, "Only a proposal can be applied.");
      if (previous) return jsonError(409, "This was already applied.");
      const source = { conversationId: ids.data.id, messageId: message.id };
      let result: Awaited<ReturnType<typeof applyProposal>>;
      try {
        result = await applyProposal(auth.value, block, input.picks, input.edits ?? {}, input.timezone ?? "UTC", source);
      } catch (error) {
        // A name the member picked that won't do: nothing was applied, so they can pick another.
        if (error instanceof NameRefused) return jsonError(400, error.message);
        throw error;
      }
      response = { status: "applied", at: Date.now(), ...result };
      // Applying the proposal is how the setup interview ends.
      if (await isSetupConversation(auth.value, ids.data.id)) await updateSetup(auth.value, { status: "done" });
    }
    await store.updateMessage(message.id, { uiResponse: { ...(message.uiResponse ?? {}), [block.id]: response } });
    return NextResponse.json({ response });
  } catch (error) {
    return errorResponse(error);
  }
}

type Applied = Extract<UiResponse, { status: "applied" }>;

class NameRefused extends Error {}

const unique = (picked: number[], length: number) => [...new Set(picked)].filter((i) => i < length).sort((a, b) => a - b);

/**
 * Applies the picked items and reports which ones took effect, so the card shows only what
 * really changed. Settings and skills are the owner's, memories need memory to be set up, and
 * how it sounds needs voice; anything else is left out rather than failing the rest.
 */
async function applyProposal(
  tenant: Tenant,
  proposal: AgentProposal,
  picks: ProposalPicks,
  edits: { profile?: string; instructions?: string; name?: string },
  timezone: string,
  source: { conversationId: string; messageId: string },
): Promise<Pick<Applied, "picks" | "applied" | "taskIds">> {
  const owner = tenant.workspace.role === "owner";
  const done: ProposalPicks = { profile: false, instructions: false, skills: [], tasks: [], memories: [] };
  const taskIds: string[] = [];

  // Its name first, since a name the member typed can be refused before anything else changes.
  // Who it is to them is theirs, so any member can keep one. A manner they already have stays.
  let name: string | undefined;
  // How it talks with them once this is applied, when its name or sound was, for the card.
  let manner: string | null | undefined;
  if (picks.identity && proposal.identity && previewEnabled(tenant, "companion")) {
    const kept = await nameCompanion(tenant, {
      name: edits.name?.trim() || proposal.identity.name,
      manner: proposal.identity.manner,
      suggested: proposal.identity.name,
      member: firstName(tenant.account.name),
    });
    if (!kept.ok) throw new NameRefused(kept.error);
    name = kept.companion.name ?? undefined;
    manner = kept.companion.manner;
    done.identity = true;
  }

  // How it sounds is theirs too, for any member with voice: the option they picked is their own
  // choice, manner and all. Never makes it arrive: only keeping a name does that.
  const sound = picks.sound !== undefined && voiceStatus(tenant) ? proposal.sound?.[picks.sound] : undefined;
  let voice: VoiceKey | undefined;
  if (sound) {
    const chosen = await setCompanionSound(tenant, { voice: sound.voice, ...(sound.manner ? { manner: sound.manner } : {}) });
    voice = sound.voice;
    manner = chosen.manner;
    done.sound = picks.sound;
  }

  const profile = owner && picks.profile && proposal.profile !== undefined ? (edits.profile ?? proposal.profile).trim() : undefined;
  const instructions =
    owner && picks.instructions && proposal.instructions !== undefined ? (edits.instructions ?? proposal.instructions).trim() : undefined;
  if (profile !== undefined || instructions !== undefined) {
    await updateSettings(tenant, {
      ...(profile !== undefined ? { profile } : {}),
      ...(instructions !== undefined ? { agentInstructions: instructions } : {}),
    });
    done.profile = profile !== undefined;
    done.instructions = instructions !== undefined;
  }

  const taskIndexes = unique(picks.tasks, proposal.tasks.length);
  const skillIndexes = unique(picks.skills, proposal.skills.length);
  let addedSkills = 0;
  const owned = await listSkills(tenant);
  const has = (catalogId: string) => owned.some((s) => s.catalogId === catalogId);
  // Library skills the picked tasks run with come along, so a task never loses its skill.
  const catalogIds = new Set<string>();
  for (const i of skillIndexes) {
    const skill = proposal.skills[i];
    if ("catalogId" in skill) catalogIds.add(skill.catalogId);
  }
  for (const i of taskIndexes) if (proposal.tasks[i].skill) catalogIds.add(proposal.tasks[i].skill!);
  for (const catalogId of catalogIds) {
    if (has(catalogId) || !owner) continue;
    const added = await ignoreConflict(addFromCatalog(tenant, catalogId));
    if (!added) continue;
    owned.push(added);
    addedSkills += 1;
  }
  for (const i of skillIndexes) {
    const skill = proposal.skills[i];
    if ("catalogId" in skill) {
      if (has(skill.catalogId)) done.skills.push(i);
    } else if (owner && (await ignoreConflict(createSkill(tenant, skill)))) {
      addedSkills += 1;
      done.skills.push(i);
    }
  }

  if (taskIndexes.length) {
    const mine = await listTasks(tenant);
    const skillFor = (catalogId?: string) => (catalogId && owned.find((s) => s.catalogId === catalogId)?.id) || null;
    for (const i of taskIndexes) {
      const task = proposal.tasks[i];
      // A template task the member already has (paused) is switched on with what they chose.
      const existing = task.templateTaskId ? mine.find((t) => t.templateTaskId === task.templateTaskId) : undefined;
      const changed = existing
        ? await updateTask(tenant, existing.id, {
            title: task.title,
            ...(task.instructions ? { instructions: task.instructions } : {}),
            ...(task.skill ? { skillId: skillFor(task.skill) } : {}),
            schedule: task.schedule,
            status: "active",
          })
        : await ignoreConflict(
            createTask(tenant, {
              title: task.title,
              instructions: task.instructions,
              skillId: skillFor(task.skill),
              schedule: task.schedule,
              timezone,
              plan: [],
              conversationId: null,
              templateTaskId: null,
            }),
          );
      if (changed) {
        done.tasks.push(i);
        taskIds.push(changed.id);
      }
    }
  }

  if (memoryEnabled()) {
    for (const i of unique(picks.memories, proposal.memories.length)) {
      await remember(tenant, proposal.memories[i], "workspace", { category: "policies", source });
      done.memories.push(i);
    }
  }

  const count = (p: ProposalPicks, lengths: AgentProposal) =>
    Number(Boolean(p.identity) && lengths.identity !== undefined) +
    Number(p.sound !== undefined && lengths.sound?.[p.sound] !== undefined) +
    Number(p.profile && lengths.profile !== undefined) +
    Number(p.instructions && lengths.instructions !== undefined) +
    unique(p.skills, lengths.skills.length).length +
    unique(p.tasks, lengths.tasks.length).length +
    unique(p.memories, lengths.memories.length).length;
  return {
    picks: done,
    applied: {
      settings: done.profile || done.instructions,
      skills: addedSkills,
      tasks: done.tasks.length,
      memories: done.memories.length,
      skipped: count(picks, proposal) - count(done, proposal),
      ...(name ? { name } : {}),
      ...(voice ? { voice } : {}),
      ...(manner !== undefined ? { manner } : {}),
    },
    ...(taskIds.length ? { taskIds } : {}),
  };
}

/** The result, or null when it's already there (another tab) or the agent is full. */
async function ignoreConflict<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if ((error as { status?: number }).status === 409) return null;
    throw error;
  }
}
