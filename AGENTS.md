# Repository guide

This repository is **Studio**: a multi-tenant Next.js workspace where people chat with a
shared AI agent (Langflow today) that they shape for any job (running a business, a job
search, a project) with their own profile, instructions, skills, memory, and connected apps. The
agent runs separately; this app never reimplements agent reasoning.

Product language: one login holds several **agents** (a business agent, a job-search agent,
a personal one). In code and the database each agent is a `workspace`; users never see
that word. Don't add user-facing "workspace" copy. The agents all work for the same person
and share them: the person's **account** (`accounts`: their name, "about you", and Composio id,
so every agent sees the same connected apps) and their personal memory. Each agent keeps its
own name, template, profile, instructions, chats, tasks, skills, and shared memory.

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
  with those, `job-search.eval.test.ts` evals the Job search template and `tidy.eval.test.ts`
  the Brain's "Tidy up" on the real model, and `library.eval.test.ts` filing a link with `file_link`.
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
- `src/lib/tenant.ts`: session → user → account + active workspace (membership-checked). The only source of identity.
  `tenant-core.ts` holds the request-free part (`resolveTenant`), with no `next/*` imports.
- `src/lib/db/store.ts`: conversation persistence, scoped to one workspace + user.
- `src/lib/workspace.ts`: settings (the agent profile, "what this agent is for", is stored in
  `workspace_settings.business_context`), usage/limits, and the per-run agent context.
- `src/lib/templates/`: built-in starting points (Job search, Small business, Sales pipeline, Inbox & calendar, Content & social, Blank). Applying
  one (`apply.ts`) copies instructions and library skills into the workspace without
  overwriting anything, and (with the "tasks" preview) gives the member the template's tasks,
  paused; suggested apps are shown, never connected automatically. Every template ships a
  `setup` interview: steps the built-in `builtin:setup` skill (`src/lib/skills/setup.ts`)
  runs with the reusable cards, ending in a `propose_agent` the owner applies. Its state is
  `workspace_settings.setup` (`src/lib/setup-state.ts`).
- `src/lib/memory.ts`: long-term memory in Supermemory, namespaced from the session: `ws_<workspace>`
  for an agent's shared facts, `u_<user>` for the person's own (shared by all their agents). Old
  per-workspace personal namespaces move into `u_<user>` on first use. The flow must not have its
  own memory connection. `memory-merge.ts` tidies it: "Tidy up" on a Brain topic attaches that
  topic's tidy skill (`src/lib/skills/tidy.ts`, facts listed by id), the agent proposes merges with
  `merge_memories`, and the member merges what they pick (keeping pins and sources) or undoes it.
- `src/lib/companion.ts`: who each agent is to one member (the "companion" preview). It starts as a
  sketch of the Studio diamond (`src/components/ui/companion.tsx`), is drawn in with their chat runs,
  is ready once it knows them (thresholds in `KNOWS_YOU`), and arrives with a name the member keeps.
  Its voice and manner are the member's to choose at any stage (`setCompanionSound`); only the name waits,
  and keeping one never replaces a manner they have.
  Moved forward after each run, never back; it never gates what the agent can do. Once ready, "Say
  hello" runs `builtin:introduce` (`src/lib/skills/introduce.ts`): the agent introduces itself from what
  it really knows and suggests a name with `propose_agent` (identity), which the member keeps or changes.
  Its name and manner then ride in every run's context, on calls and in push titles. Members never read
  the stage words: the change is shown, not announced.
- `src/lib/account.ts`: the person's profile (Settings → You, onboarding's first step), sent to
  every agent as "You're assisting".
- `src/lib/skills/`: skills, named instructions a user attaches to one message ("/" in the
  composer). The built-in library `catalog.ts`, workspace copies `index.ts`, and the message
  sent to the agent `render.ts`. Skills never ride along on runs they aren't attached to, with one
  exception: while an agent's setup interview is in progress, its setup skill is in the context of
  every run in that conversation (`buildAgentContext`), since a long interview scrolls the first
  message out of the agent's view.
- `src/lib/tasks/`: long-horizon tasks (a goal, a plan, a schedule, a linked conversation) and
  their runs (`index.ts`), the agent's tracker of records per collection (`records.ts`), and
  request validation (`schema.ts`). Private to each member; the API is the "tasks" preview.
  `run-task.ts` starts a task's run as its member, for "Run now" and the worker alike.
- `src/lib/agent/`: provider-neutral interface (`types.ts`), `langflow.ts`, `mock.ts`, registry `index.ts`.
- `src/lib/chat/turn.ts`: runs one turn (persist, stream, heartbeat, timeout, final state).
  `run.ts` builds its deps from a tenant (`buildTurnDeps`), free of Next.js so a worker can run turns;
  `no-next.test.ts` keeps it that way.
- `src/lib/integrations/composio.ts`: connected apps, always keyed by the caller's Composio id
  (`accounts.composio_user_id`, one per person; `workspace_members.composio_user_id` is legacy).
- `src/lib/agent-files.ts`: a member's own files for one agent (a résumé), sent with every run of
  that agent ahead of project files (`runFiles` caps them). `claimAsAgentFile` moves an unsent upload there.
- `src/lib/library.ts`: the member's Library for one agent (`agent_artifacts`): docs the agent made,
  filed from its tools' own artifact results as each reply streams (one row per link), links the agent
  files when the member asks it to keep one (`file_link`), and links the member pastes. Each run's
  context lists it so the agent reopens what it made. The page
  (`src/components/library/`) lists each tracker collection in brief, opening to its own page (`/library/<collection>`), and the member's agent files.
- `src/lib/attachments.ts`: uploaded files (private Storage bucket, `<workspace>/<member>/` paths).
- `src/lib/push.ts` + `public/sw.js`: notifications on members' devices (Web Push), sent when a
  run ends while the member isn't watching. Studio installs as a home-screen app (`src/app/manifest.ts`).
- `src/lib/voice/`: voice calls (preview; `docs/voice.md`). `index.ts` starts and ends calls under
  the member's session (`claim_voice` caps daily voice time; `claimVoiceClip` charges speech outside
  calls to the same time), `voices.ts` is Studio's voice catalog (keys only; `elevenlabs.ts` alone
  maps them to provider voices), `speech.ts` says text and hears recordings (a labeled tone under
  the mock), `seal.ts` seals the call's context and keys the names clips are charged under,
  `front.ts` is the voice front ElevenLabs calls (`/api/voice/llm/v1/chat/completions`),
  `persona.ts` its prompt and tools, and (`resolvePersona`) the name, voice and manner an agent has
  with one member everywhere it speaks, `relay.ts` what it may say about a run, `intent.ts` what the
  member's own words ask for. The call screen is `src/components/voice/call.tsx`; card drafts it
  shares with the thread are `src/components/chat/card-drafts.tsx`, checked by `src/lib/chat/ui-fill.ts`.
  Outside calls: the message box's mic (`mic.ts`, `src/components/chat/mic.tsx`: hold to send a voice
  message, tap to dictate; `/api/voice/transcribe`), and voice notes (`notes.ts` picks which replies
  get one and its words, saved as `messages.voice_note`; `clips.ts` says one on play through
  `…/messages/<id>/speech`). One clip plays at a time (`src/components/voice/player.tsx`).
- `trigger/`: the background worker (Trigger.dev, `trigger.config.ts`). `dispatch.ts` claims due
  tasks every two minutes; `run-task.ts` signs in as each task's member and asks the app to run
  it (`POST /api/tasks/<id>/runs/<run>`), so runs use the app's own settings and keys and the
  worker holds only the Supabase keys and `APP_URL`. `lib/elevated.ts` is the only code with
  the Supabase secret key.
- `langflow/`: Langflow components the flow needs (Tool Gateway with approvals, Workspace
  Context, Member Apps for per-member Composio tools, Studio Browser for a Browserbase browser per
  conversation, Load Skill) and `install.py`, which
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
  The other cookieless route is the voice front (`/api/voice/llm/v1/chat/completions`), which
  checks the voice provider's key and the call's sealed context and touches no data. Every other
  route takes cookie sessions only. Writes are refused from other sites; a GET that changes
  something anyway (one that charges voice time) passes `authorizeTenant(request, { writes: true })`.
- Keep provider-specific logic inside its adapter. Declare capabilities honestly; don't
  assume streaming, cancellation, or tool events a provider hasn't been verified to send.
- Never hardcode a tenant, template, or use case into agent or app logic. Templates are
  generic, public starting points copied into a workspace; per-workspace settings and copies
  carry the specifics.
- The flow is shared by every tenant: nothing in it may hold one tenant's connections or
  memory (per-member values arrive through tweaks), and no tool may run code in the
  Langflow server process.
- The agent may write the member's own Studio state (memory, a task's plan, tracker rows, Library links) without
  approval, but only through gateway tools that return structured results the app validates
  and saves under the member's session; the member sees each write as a step and can edit or
  undo it. Anything touching their external accounts still needs approval.
- Anything the agent does that changes a member's accounts must pause for their approval
  (`take_action` in the gateway). Don't add tools that write without it, and never approve on
  the member's behalf. Provider resume state stays server-side.
- Agent-rendered UI is built as reusable gateway tools any skill can call (`ask_user`,
  `show_form`, `propose_agent`, `merge_memories`; cards in `src/components/chat/ui-cards.tsx` and
  `requests.tsx`), never as UI for one flow or template. They change nothing: a form's
  answers go out as the member's next message, and a proposed setup applies only when the
  member clicks Apply, and the card shows only what took effect.
- Render only what the backend reports: no invented activity, statuses, or artifacts, and no
  artifact parsing from free text. Mock output stays clearly labeled.
- Secrets stay server-side in `src/lib/config.ts`; only `NEXT_PUBLIC_SUPABASE_*` reach the browser.
  The only provider credential the browser gets is a short-lived voice session token.
- The voice front talks and is never a second agent. It may only reflect the member's words back,
  say what the worker reported (relay lines, the reply, card contents), ask them to clarify, and
  say a holding line. Anything else goes to the worker in the member's exact words (the
  speech-to-text transcript, never the voice model's paraphrase). It has no tools that act, no
  knowledge base, and no memory, and its prompt is built per call on the server, with the
  member's guardrail first. Its session context is sealed and bound to the call; it reads no data.
- A card is sent by voice only on the member's clear "send" in their own transcript, and a
  running job is redirected only on a clear "stop" or "actually…" (redirecting stops it and
  declines a pending approval); other talk-over is held until it lands. Files, connecting apps,
  Apply, "Do the first one now", and approvals stay taps. A spoken approval (Phase 3) needs a
  read-back, the member's yes from speech-to-text, and a visible cancel hold, is stored with
  their words, and never covers money, deletions, or bulk sends.
- Studio never stores audio. Dictation and voice messages send a recording once to be turned
  into words and keep only the words; a voice note keeps only its words and is spoken each time
  it's played. Screen or camera frames are taken only when the member asks.
- Navigation in the chat shell is client-side history with the path in `Workspace` state.
- Design tokens live in `src/app/globals.css`; use the token utilities, not raw colors.
- Don't add dependencies without need.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
