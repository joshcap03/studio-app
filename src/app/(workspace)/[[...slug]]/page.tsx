import { notFound } from "next/navigation";
import { z } from "zod";
import { TabAgent } from "@/components/tab-agent";
import { Workspace, type InitialProject, type InitialThread } from "@/components/workspace/workspace";
import { getAgentStatus } from "@/lib/agent";
import { marksOf } from "@/lib/chat/move";
import { storeFor } from "@/lib/chat/store-for";
import { MAX_MOVES } from "@/lib/db/store";
import { getCompanions, withToMeet } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { journeyOrNone } from "@/lib/journey";
import { getProject, listProjects } from "@/lib/projects";
import { listSkills } from "@/lib/skills";
import { builtinSkills } from "@/lib/skills/builtin";
import { summarizeSetup } from "@/lib/setup-state";
import { requirePageTenant } from "@/lib/tenant";
import { firstName } from "@/lib/setup-words";
import { dictationStatus, voiceStatus } from "@/lib/voice";
import { messagesWithCalls } from "@/lib/voice/calls";
import { resolvePersona } from "@/lib/voice/persona";
import { MESSAGE_PAGE } from "@/lib/types";
import { getSettings } from "@/lib/workspace";

// One page serves "/" (new conversation), "/c/<id>", "/p/<project id>", "/tasks[/<task id>]", and "/library[/<tracker>]". After the first load the browser
// switches conversations in place, without a server round trip per navigation.

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ skill?: string | string[] }>;
}) {
  const tenant = await requirePageTenant();

  const { slug = [] } = await params;
  let conversationId: string | null = null;
  let projectId: string | null = null;
  if (slug[0] === "library") {
    // A tracker's page loads in the browser, like a task.
    if (slug.length > 2 || (slug.length === 2 && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(slug[1]))) notFound();
  } else if (slug[0] === "tasks") {
    // The task itself loads in the browser, like a project opened from the sidebar.
    if (slug.length > 2 || (slug.length === 2 && !z.uuid().safeParse(slug[1]).success)) notFound();
  } else if (slug.length > 0) {
    const id = z.uuid().safeParse(slug[1]);
    if (slug.length !== 2 || (slug[0] !== "c" && slug[0] !== "p") || !id.success) notFound();
    if (slug[0] === "c") conversationId = id.data;
    else projectId = id.data;
  }

  const store = storeFor(tenant);
  // Who each agent is to this member (a preview); without it, everything looks as before.
  const companions = previewEnabled(tenant, "companion")
    ? getCompanions(tenant).catch((error) => {
        console.error("[companion] unavailable", error);
        return null;
      })
    : null;
  const [conversations, conversation, workspaceSkills, projects, project, settings] = await Promise.all([
    store.listConversations(),
    conversationId ? store.getConversation(conversationId) : null,
    listSkills(tenant),
    listProjects(tenant),
    projectId ? getProject(tenant, projectId) : null,
    getSettings(tenant),
  ]);
  const all = await companions;
  // What's left before the agent they're in introduces itself (best effort: the mark shows anyway).
  const here = all?.[tenant.workspace.id];
  const own =
    all && here
      ? { ...all, [here.workspaceId]: await withToMeet(tenant, here, settings.setup).catch(() => here) }
      : all;
  const initialProject: InitialProject | null = projectId ? { id: projectId, project } : null;
  const skills = [...builtinSkills(tenant), ...workspaceSkills];
  const requested = (await searchParams).skill;
  const initialSkillId = skills.find((s) => s.id === requested)?.id ?? null;

  // The owner's setup interview: how far along it is, for the "Finish setting up" banner.
  const setup = summarizeSetup(tenant, settings.setup, settings.templateId);

  // Voice for every member with it (the mic, voice notes, calls); talking setup through stays the owner's.
  const voice = voiceStatus(tenant);
  // The name the voice goes by on calls, as the server picks it for them: on the call button and the setup banner.
  const greeter = voice
    ? (await resolvePersona(tenant, { templateId: settings.templateId, ...(own ? { companion: own[tenant.workspace.id] ?? null } : {}) })).name
    : null;

  // The open conversation with the plan of the work in it, and whose move it is in the latest
  // conversations for the sidebar's marks (best-effort: the browser asks again).
  const [thread, moves] = await Promise.all([
    conversation ? Promise.all([store.pageMessages(conversation.id, { limit: MESSAGE_PAGE }), journeyOrNone(tenant, conversation.id)]) : null,
    store
      .lastMessages(conversations.slice(0, MAX_MOVES).map((c) => c.id))
      .then(marksOf)
      .catch((error) => {
        console.error("[moves] unavailable", error);
        return {};
      }),
  ]);
  let initialThread: InitialThread | null = null;
  if (conversationId) {
    // The calls its messages were said on, for their recaps (and nothing of voice, with it off).
    const said = thread ? await messagesWithCalls(tenant, thread[0].messages) : null;
    initialThread = thread && said
      ? { id: conversationId, status: "ready", messages: said.messages, earlier: thread[0].earlier, journey: thread[1], calls: said.calls }
      : { id: conversationId, status: "missing", messages: [], earlier: false, journey: null, calls: [] };
  }

  return (
    <>
      <TabAgent id={tenant.workspace.id} />
      <Workspace
        initialConversations={conversations}
        initialMoves={moves}
        initialThread={initialThread}
        initialProjects={projects}
        initialProject={initialProject}
        agent={getAgentStatus(tenant.workspace.id)}
        workspace={tenant.workspace}
        workspaces={tenant.workspaces}
        email={tenant.email}
        skills={skills}
        initialSkillId={initialSkillId}
        setup={setup}
        voice={voice}
        dictation={dictationStatus()}
        member={firstName(tenant.account.name)}
        greeter={greeter}
        companions={own}
      />
    </>
  );
}
