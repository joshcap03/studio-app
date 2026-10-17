# Repository guide

This repository is **Studio**: a multi-tenant Next.js workspace where people chat with a
shared AI agent (Langflow today) that they shape for any job (running a business, a job
search, a project) with their own profile, instructions, skills, memory, and connected apps. The
agent runs separately; this app never reimplements agent reasoning.

This repository is public. Never commit business data, secrets, real customer or member
details, or anything specific to one business. A local `archive/` folder, if present, is
gitignored and stays out of the repo.

## Commands

- `npm run db:start` / `npm run db:reset`: local Supabase (Docker via Colima) / reapply migrations
- `npm run dev`: http://127.0.0.1:3000 (reads `.env.local`)
- `npm run qa:serve`: QA server on http://127.0.0.1:3100 for browser automation and API tests.
  Create throwaway accounts (`*@example.test`); never use real credentials.
- `npm run typecheck`, `npm test`, `npm run build`
- `npm run test:integration`: needs local Supabase; API tests also need `qa:serve`;
  Langflow tests need `LANGFLOW_TEST_BASE_URL`, `LANGFLOW_TEST_API_KEY`, `LANGFLOW_TEST_FLOW_ID`;
  with those, `job-search.eval.test.ts` evals the Job search template on the real model.
- `npx trigger.dev dev`: runs the background worker locally (needs a Trigger.dev login and
  `TRIGGER_PROJECT_REF`); it deploys from GitHub Actions after each Vercel production deploy.

Verify before handoff: typecheck, test, build, and the integration suite when touching data
access, auth, or the agent boundary. For UI changes, drive the flow on the QA server.

Changes to how agent steps are labeled, summarized (Results panel), or reported as errors
must hold for **every tool**, not just the one in front of you: run `npm run test:audit`
(set `LANGFLOW_AUDIT_BASE_URL`, `LANGFLOW_AUDIT_API_KEY`, `LANGFLOW_AUDIT_FLOW_ID`), which
replays every tool call in the flow's real history and fails on missing findings or
raw/technical text.

## Layout

- `supabase/migrations/`: schema, RLS policies, RPCs. Append new migrations; never edit applied ones.
- `src/lib/tenant.ts`: session → user → active workspace (membership-checked). The only source of identity.
  `tenant-core.ts` holds the request-free part (`resolveTenant`), with no `next/*` imports.
- `src/lib/db/store.ts`: conversation persistence, scoped to one workspace + user.
- `src/lib/workspace.ts`: settings (the agent profile, "what this agent is for", is stored in
  `workspace_settings.business_context`), usage/limits, and the per-run agent context.
- `src/lib/templates/`: built-in starting points (Job search, Small business, Blank). Applying
  one (`apply.ts`) copies instructions and library skills into the workspace without
  overwriting anything, and (with the "tasks" preview) gives the member the template's tasks,
  paused; suggested apps are shown, never connected automatically.
- `src/lib/memory.ts`: long-term memory in Supermemory, namespaced per workspace and per member
  from the session. The flow must not have its own memory connection.
- `src/lib/skills/`: skills, named instructions a user attaches to one message ("/" in the
  composer). The built-in library `catalog.ts`, workspace copies `index.ts`, and the message
  sent to the agent `render.ts`. Skills never ride along on runs they aren't attached to.
- `src/lib/tasks/`: long-horizon tasks (a goal, a plan, a schedule, a linked conversation) and
  their runs (`index.ts`), the agent's tracker of records per collection (`records.ts`), and
  request validation (`schema.ts`). Private to each member; the API is the "tasks" preview.
  `run-task.ts` starts a task's run as its member, for "Run now" and the worker alike.
- `src/lib/agent/`: provider-neutral interface (`types.ts`), `langflow.ts`, `mock.ts`, registry `index.ts`.
- `src/lib/chat/turn.ts`: runs one turn (persist, stream, heartbeat, timeout, final state).
  `run.ts` builds its deps from a tenant (`buildTurnDeps`), free of Next.js so a worker can run turns;
  `no-next.test.ts` keeps it that way.
- `src/lib/integrations/composio.ts`: connected apps, always keyed by the caller's Composio id.
- `src/lib/attachments.ts`: uploaded files (private Storage bucket, `<workspace>/<member>/` paths).
- `src/lib/push.ts` + `public/sw.js`: notifications on members' devices (Web Push), sent when a
  run ends while the member isn't watching. Studio installs as a home-screen app (`src/app/manifest.ts`).
- `trigger/`: the background worker (Trigger.dev, `trigger.config.ts`). `dispatch.ts` claims due
  tasks every two minutes; `run-task.ts` signs in as each task's member and asks the app to run
  it (`POST /api/tasks/<id>/runs/<run>`), so runs use the app's own settings and keys and the
  worker holds only the Supabase keys and `APP_URL`. `lib/elevated.ts` is the only code with
  the Supabase secret key.
- `langflow/`: Langflow components the flow needs (Tool Gateway with approvals, Workspace
  Context, Member Apps for per-member Composio tools, Load Skill) and `install.py`, which
  backs up a flow and installs them.
- `src/app/`: pages (`(workspace)`, `login`, `onboarding`, `settings`) and `api/` routes.
- `src/components/`: `workspace/` (chat state owner), `chat/`, `sidebar/`, `settings/`, `ui/`.

## Rules

- Derive user and workspace from the session (`authorizeTenant` / `requirePageTenant`). Never
  accept a workspace or user id from a URL, body, or unverified cookie.
- Query Supabase only through the user's session client so RLS applies; don't add a
  service-role client to request paths. Every new table gets RLS policies and an isolation test.
  The one exception is the background worker: `trigger/lib/elevated.ts`, and nothing else, holds
  `SUPABASE_SECRET_KEY`, only to call the service_role-only `worker_*` functions and to open a
  short-lived session as a task's member (magic link + verify, checked to be that member, signed
  out with local scope). The admin client never touches tables; everything after runs as the
  member under RLS. `src/lib/elevated-guard.test.ts` enforces this. That session's access token
  goes only to `POST /api/tasks/<id>/runs/<run>`, the one route that accepts a bearer token
  (verified with Supabase Auth; `src/proxy.ts` lets only that route through without a cookie).
  Every other route takes cookie sessions only.
- Keep provider-specific logic inside its adapter. Declare capabilities honestly; don't
  assume streaming, cancellation, or tool events a provider hasn't been verified to send.
- Never hardcode a tenant, template, or use case into agent or app logic. Templates are
  generic, public starting points copied into a workspace; per-workspace settings and copies
  carry the specifics.
- The flow is shared by every tenant: nothing in it may hold one tenant's connections or
  memory (per-member values arrive through tweaks), and no tool may run code in the
  Langflow server process.
- The agent may write the member's own Studio state (memory, a task's plan, tracker rows) without
  approval, but only through gateway tools that return structured results the app validates
  and saves under the member's session; the member sees each write as a step and can edit or
  undo it. Anything touching their external accounts still needs approval.
- Anything the agent does that changes a member's accounts must pause for their approval
  (`take_action` in the gateway). Don't add tools that write without it, and never approve on
  the member's behalf. Provider resume state stays server-side.
- Render only what the backend reports: no invented activity, statuses, or artifacts, and no
  artifact parsing from free text. Mock output stays clearly labeled.
- Secrets stay server-side in `src/lib/config.ts`; only `NEXT_PUBLIC_SUPABASE_*` reach the browser.
- Navigation in the chat shell is client-side history with the path in `Workspace` state.
- Design tokens live in `src/app/globals.css`; use the token utilities, not raw colors.
- Don't add dependencies without need.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
