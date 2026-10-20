import { notFound } from "next/navigation";
import { z } from "zod";
import { Workspace, type InitialProject, type InitialThread } from "@/components/workspace/workspace";
import { getAgentStatus } from "@/lib/agent";
import { storeFor } from "@/lib/chat/store-for";
import { getCompanions } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { getProject, listProjects } from "@/lib/projects";
import { listSkills } from "@/lib/skills";
import { builtinSkills } from "@/lib/skills/builtin";
import { summarizeSetup } from "@/lib/setup-state";
import { requirePageTenant } from "@/lib/tenant";
import { firstName } from "@/lib/setup-words";
import { voiceStatus } from "@/lib/voice";
import { resolvePersona } from "@/lib/voice/persona";
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
  const own = await companions;
  const initialProject: InitialProject | null = projectId ? { id: projectId, project } : null;
  const skills = [...builtinSkills(tenant), ...workspaceSkills];
  const requested = (await searchParams).skill;
  const initialSkillId = skills.find((s) => s.id === requested)?.id ?? null;

  // The owner's setup interview: how far along it is, for the "Finish setting up" banner.
  const setup = summarizeSetup(tenant, settings.setup, settings.templateId);

  // Voice for every member with it (the mic, voice notes, calls); talking setup through stays the owner's.
  const voice = voiceStatus(tenant);
  // The name the voice greets them with on the setup banner, as the server picks it for calls.
  const greeter = voice && setup
    ? (await resolvePersona(tenant, { templateId: settings.templateId, ...(own ? { companion: own[tenant.workspace.id] ?? null } : {}) })).name
    : null;

  let initialThread: InitialThread | null = null;
  if (conversationId) {
    initialThread = conversation
      ? { id: conversationId, status: "ready", messages: await store.listMessages(conversationId) }
      : { id: conversationId, status: "missing", messages: [] };
  }

  return (
    <Workspace
      initialConversations={conversations}
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
      member={firstName(tenant.account.name)}
      greeter={greeter}
      companions={own}
    />
  );
}
