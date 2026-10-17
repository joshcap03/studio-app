import { notFound } from "next/navigation";
import { z } from "zod";
import { Workspace, type InitialProject, type InitialThread } from "@/components/workspace/workspace";
import { getAgentStatus } from "@/lib/agent";
import { storeFor } from "@/lib/chat/store-for";
import { getProject, listProjects } from "@/lib/projects";
import { listSkills } from "@/lib/skills";
import { builtinSkills } from "@/lib/skills/builtin";
import { templateById, setupSteps, type AgentTemplate } from "@/lib/templates";
import { requirePageTenant } from "@/lib/tenant";
import type { SetupSummary } from "@/lib/types";
import { getSettings } from "@/lib/workspace";

// One page serves "/" (new conversation), "/c/<id>", "/p/<project id>", and "/tasks[/<task id>]". After the first load the browser
// switches conversations in place, without a server round trip per navigation.

export const dynamic = "force-dynamic";

const setupStepCount = (template: AgentTemplate | undefined) => (template ? setupSteps(template).length : 0);

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
  if (slug[0] === "tasks") {
    // The task itself loads in the browser, like a project opened from the sidebar.
    if (slug.length > 2 || (slug.length === 2 && !z.uuid().safeParse(slug[1]).success)) notFound();
  } else if (slug.length > 0) {
    const id = z.uuid().safeParse(slug[1]);
    if (slug.length !== 2 || (slug[0] !== "c" && slug[0] !== "p") || !id.success) notFound();
    if (slug[0] === "c") conversationId = id.data;
    else projectId = id.data;
  }

  const store = storeFor(tenant);
  const [conversations, conversation, workspaceSkills, projects, project, settings] = await Promise.all([
    store.listConversations(),
    conversationId ? store.getConversation(conversationId) : null,
    listSkills(tenant),
    listProjects(tenant),
    projectId ? getProject(tenant, projectId) : null,
    getSettings(tenant),
  ]);
  const initialProject: InitialProject | null = projectId ? { id: projectId, project } : null;
  const skills = [...builtinSkills(tenant), ...workspaceSkills];
  const requested = (await searchParams).skill;
  const initialSkillId = skills.find((s) => s.id === requested)?.id ?? null;

  // The owner's setup interview: how far along it is, for the "Finish setting up" banner.
  const setup: SetupSummary | null =
    tenant.workspace.role === "owner"
      ? {
          status: settings.setup?.status ?? "not_started",
          conversationId: settings.setup?.conversationId ?? null,
          done: settings.setup?.plan.filter((s) => s.status === "done").length ?? 0,
          total: settings.setup?.plan.length || setupStepCount(templateById(settings.templateId)),
        }
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
    />
  );
}
