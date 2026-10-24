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
  own memory connection. Each run lists the newest facts the member may change by id (`recentMemories`),
  and `remember` takes `replaces`, so a fact that changes or restates one takes its place
  (`rememberReplacing`; the reply's Undo brings the old ones back) instead of piling up copies. `memory-merge.ts` tidies it: "Tidy up" on a Brain topic attaches that
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
  request validation (`schema.ts`). The member reads each collection as a list in the Library, so
  `fields.ts` keeps it one list: the agent's placeholders ("None", "n/a") are dropped on save, saving
  a row again adds to its fields rather than replacing them, each collection's rows show the same
  detail fields (the rest open from the row), and every run is told the collections and field names
  already in use so it reuses them instead of starting a second list for the same thing. Private to each member; the API is the "tasks" preview.
  `run-task.ts` starts a task's run as its member, for "Run now" and the worker alike.
  `watches.ts`: a task that runs when something happens in a connected app (the "watches" preview,
  docs/watches.md). Its Composio trigger is created under the member's own id and follows the task;
  Composio's events reach `/api/watches/composio`, the worker matches each to its watch and owner
  (`worker_claim_watch_event`) and folds events close together into one waiting run. A watch's run
  reads them as other people's words: the gateway asks before code, the browser, or any link
  (`run_cause`), and what it remembers goes to the agent's shared memory.
- `src/lib/journey.ts`: where the plan for the work in a conversation lives and how the member sees it
  (the rail above the chat, "Done means …"): the conversation's task's plan, else the owner's setup
  checklist while the interview is under way there, else the conversation's own (`conversations.plan`/
  `goal`), for any work with several steps. The agent keeps it with `update_plan` (`savePlanFromAgent`
  in `tasks/agent.ts`); each save streams a `journey` event. The goal comes only from update_plan's
  argument, never from the reply's text; a task's goal (which the member can set on the task) stays
  until the agent gives a new one. The member edits a task's plan and goal on the task, and clears a
  conversation's own from its rail (`PATCH /api/conversations/<id>` with `plan: null`).
- `src/lib/chat/move.ts`: whose move it is in a conversation (working, the member's call, done, stuck,
  idle), from real state only. The one signal for the reply's mark, the composer hint, the call's orb,
  the rail, the sidebar's marks (`conversation_moves`, `GET /api/conversations/moves`), and push copy.
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
- `src/lib/voice/`: voice calls (preview; `docs/voice.md`), out of the app unless `VOICE_ENABLED=on`
  (`voiceConfig` in `src/lib/config.ts`; `qa:serve` sets it). `index.ts` starts and ends calls under
  the member's session (`claim_voice` caps daily voice time; `claimVoiceClip` charges speech outside
  calls to the same time), `voices.ts` is Studio's voice catalog (keys only; `elevenlabs.ts` alone
  maps them to provider voices), `speech.ts` says text and hears recordings (a labeled tone under
  the mock), `seal.ts` seals the call's context and keys the names clips are charged under,
  `front.ts` is the voice front ElevenLabs calls (`/api/voice/llm/v1/chat/completions`),
  `persona.ts` its prompt and tools, and (`resolvePersona`) the name, voice and manner an agent has
  with one member everywhere it speaks, `relay.ts` what it may say about a run, `intent.ts` what the
  member's own words ask for. The call screen is `src/components/voice/call.tsx`; card drafts it
  shares with the thread are `src/components/chat/card-drafts.tsx`, checked by `src/lib/chat/ui-fill.ts`.
  It docks as a bar over the app by default and follows the chat on screen; `places.ts` finds where
  "open …" goes.
  A call can start in any conversation and follows a task's run there; `calls.ts` checks which call
  a message was said on, and `recap.ts` builds the card after a call from the records (nothing stored).
  Outside calls: the message box's mic (`mic.ts`, `src/components/chat/mic.tsx`: hold to send a voice
  message, tap to dictate; `/api/voice/transcribe`), and voice notes (`notes.ts` picks which replies
  get one and its words, saved as `messages.voice_note`; `clips.ts` says one on play through
  `…/messages/<id>/speech`). One clip plays at a time (`src/components/voice/player.tsx`).
  On a call the member can watch the agent's browser, view only: `src/lib/browser-view.ts` keeps the
  conversation's sealed session id and takes screenshots server-side (the connection never leaves
  the server).
- `src/lib/browser-fill.ts` + `src/lib/secrets/`: logins, cards, and one-time codes for the agent's browser. The agent's
  `request_secret` shows the secure card (`src/components/chat/secret-card.tsx`); the member picks a
  saved one or types one, and the server types it into the conversation's browser over CDP
  (`/api/conversations/<id>/secrets/<block>`): an https page only, a saved login only on its own site.
  "Do it myself" takes the browser over (clicks, keys, and typing relayed by `…/browser/input`).
  Saved ones (`credentials`, the person's, shared by their agents) are sealed with `CREDENTIALS_KEY`
  and kept in Supabase Vault; a card's security code is never saved. Settings → Saved logins & cards
  lists and removes them.
- Handing over the agent's browser, for a CAPTCHA or a page only the member can use (a Google
  sign-in button, a passkey): the agent calls `hand_browser` and the member gets a "Take over" card
  (`src/components/chat/browser-handoff.tsx`). Their tap fetches a short-lived Browserbase live view
  of that conversation's browser (`browserControl` in `src/lib/browser-view.ts`, `POST
  /api/conversations/<id>/browser/control`), shown only to them; Done hands it back as their next
  message. Sign-in and payment forms go through `request_secret`, and a one-time code (2FA) is found
  in the member's email by the agent, or asked for on the same secure card (`kind: code`) and typed
  by the server. `src/lib/browser-signins.ts` keeps one Browserbase context per
  person (sealed on `accounts.browser_context`, shared by all their agents), sent to Studio Browser
  each run as `{{browser_context}}`, so sites they signed in to stay signed in; Settings forgets them.
- "Show me once" (`builtin:teach`, `src/lib/skills/teach.ts`, owners where there's a hosted browser):
  the member teaches the agent a job by doing it once. The agent opens the page and calls `watch_me`,
  a `hand_browser` card marked `watch` (`src/components/chat/show-me.tsx`). The member drives the
  browser through Studio (`BrowserDrive`, `…/browser/input` with `record`), so the server says what
  each input was done to by the page's own names, never a field's value, and never what was typed into
  a password, card, or code field (`drivePage` in `src/lib/browser-fill.ts`). Their notes, typed or
  said on a call (`show-me-notes.ts`: the call hands its words to the recording card instead of the
  worker), go along. Done sends the steps as their next message (`src/lib/chat/show-me.ts`), and the
  agent proposes the skill with `propose_agent`, listing its guesses in `assumptions`; the card lets
  the member read and reword the skill, and fix a guess, which goes back as their next message.
- `trigger/`: the background worker (Trigger.dev, `trigger.config.ts`). `dispatch.ts` claims due
  tasks every two minutes; `watch-event.ts` takes a watch's events as the webhook hands them over;
  `run-task.ts` signs in as each task's member and asks the app to run
  it (`POST /api/tasks/<id>/runs/<run>`), so runs use the app's own settings and keys and the
  worker holds only the Supabase keys and `APP_URL`. `lib/elevated.ts` is the only code with
  the Supabase secret key.
- `langflow/`: Langflow components the flow needs (Tool Gateway with approvals, Workspace
  Context, Member Apps for per-member Composio tools, Studio Browser for a Browserbase browser per
  conversation, kept alive while the agent waits on the member, Load Skill) and `install.py`, which
  backs up a flow and installs them.
- `src/app/`: pages (`(workspace)`, `login`, `onboarding`, `settings`) and `api/` routes.
- `src/components/`: `workspace/` (chat state owner), `chat/`, `sidebar/`, `settings/`, `ui/`.

## Rules

- Derive user and workspace from the session (`authorizeTenant` / `requirePageTenant`). Never
  accept a workspace or user id from a URL, body, or unverified cookie. The active-agent cookie
  is the last agent picked in any tab, so each page names its own (`<TabAgent>`) and the browser
  sends it on every API request (`agentHeaders()`, `src/lib/client/tab-agent.ts`); the server
  honors it only for the member's own agents and never falls back to another.
- Query Supabase only through the user's session client so RLS applies; don't add a
  service-role client to request paths. Every new table gets RLS policies and an isolation test.
  The one exception is the background worker: `trigger/lib/elevated.ts`, and nothing else, holds
  `SUPABASE_SECRET_KEY`, only to call the service_role-only `worker_*` functions and to open a
  short-lived session as a task's member (magic link + verify, checked to be that member, signed
  out with local scope). The admin client never touches tables; everything after runs as the
  member under RLS. `src/lib/elevated-guard.test.ts` enforces this. That session's access token
  goes only to `POST /api/tasks/<id>/runs/<run>`, the one route that accepts a bearer token
  (verified with Supabase Auth; `src/proxy.ts` lets only that route through without a cookie).
  The other cookieless routes are the voice front (`/api/voice/llm/v1/chat/completions`), which
  checks the voice provider's key and the call's sealed context and touches no data, and the
  watch webhook (`/api/watches/composio`), which checks Composio's signature, reads and writes no
  member data, and only hands the event to the worker (with `TRIGGER_SECRET_KEY`). Every other
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
- The agent may write the member's own Studio state (memory, a task's or a conversation's plan,
  tracker rows, Library links) without approval, but only through gateway tools that return
  structured results the app validates and saves under the member's session; the member sees
  each write as a step and can edit or undo it. Anything touching their external accounts
  still needs approval.
- Anything the agent does that changes a member's accounts must pause for their approval
  (`take_action` in the gateway). Don't add tools that write without it, and never approve on
  the member's behalf. Provider resume state stays server-side.
- Agent-rendered UI is built as reusable gateway tools any skill can call (`ask_user`,
  `show_form`, `propose_agent`, `merge_memories`, `offer_call`, `hand_browser`, `watch_me`; cards in `src/components/chat/ui-cards.tsx` and
  `requests.tsx`), never as UI for one flow or template. They change nothing: a form's
  answers go out as the member's next message, a proposed setup applies only when the
  member clicks Apply, and the card shows only what took effect; an offer to call only
  offers (never a push), and is kept only where the member could take one.
- Render only what the backend reports: no invented activity, statuses, or artifacts, and no
  artifact parsing from free text. Mock output stays clearly labeled.
- Secrets stay server-side in `src/lib/config.ts`; only `NEXT_PUBLIC_SUPABASE_*` reach the browser.
  The only provider credentials the browser gets are a short-lived voice session token and, on the
  member's own tap on a `hand_browser` card, a short-lived live view of their conversation's agent
  browser (never stored, never sent to the agent).
- A member's password or card never reaches the agent: never in chat, a form, `messages`, cards'
  responses, approvals, step details, Langflow, memory, or the voice front, and never logged. It goes
  from the secure card to the server to the browser's CDP connection (or sealed into the store), and the
  agent hears only what was filled. Card numbers are masked in tool output on both sides as a backstop.
  The agent's browser is driven by the member through server-relayed input; no connection or
  debugger link reaches the page, except that one live view, on that one card, after their tap.
- The voice front talks and is never a second agent. It may only reflect the member's words back,
  say what the worker reported (relay lines, the reply, card contents), ask them to clarify, and
  say a holding line. Anything else goes to the worker in the member's exact words (the
  speech-to-text transcript, never the voice model's paraphrase). It has no tools that act, no
  knowledge base, and no memory, and its prompt is built per call on the server, with the
  member's guardrail first. Its session context is sealed and bound to the call; it reads no data.
- A call docks over the app, so the member keeps using Studio while they talk. The voice front may
  move the view (`open`: it changes nothing) and press a button on the page they're on that they
  named (`press`), each only on the member's own words, read by fixed rules; a button that changes
  Studio state (run, pause, resume a task) waits out a visible hold anything they say stops. Pages
  offer buttons with `useScreenButtons` (`src/components/voice/screen.tsx`), never one flow's UI.
- A card is sent by voice only on the member's clear "send" in their own transcript, and a
  running job is redirected only on a clear "stop" or "actually…" (redirecting stops it and
  declines a pending approval); other talk-over is held until it lands. Files, connecting apps,
  Apply, and "Do the first one now" stay taps. A spoken approval needs a read-back said in full,
  the member's own "send it" from speech-to-text (never typed), and a visible cancel hold
  (`src/lib/voice/approval-guard.ts`), is routed by fixed rules (never the voice model), checked
  again on the server (`src/lib/voice/approvals.ts`), recorded only by the database's
  `settle_spoken_approval` on the member's own open call, stored with their words, and never covers
  money, deletions, bulk sends, or anything it can't read back (`src/lib/approvals/spoken.ts`,
  decided when the agent asks). One "That's not what I said" turns it off for everyone until
  cleared with SQL (docs/voice.md).
- Studio never stores audio. Dictation and voice messages send a recording once to be turned
  into words and keep only the words; a voice note keeps only its words and is spoken each time
  it's played. Showing a call your screen or camera starts only with a tap and stays on the
  member's device; a frame is taken only on their own "look at this" (from speech-to-text) or a tap
  on Snap, and goes as an ordinary attachment with their words (`src/components/voice/share.ts`).
- Navigation in the chat shell is client-side history with the path in `Workspace` state.
- Design tokens live in `src/app/globals.css`; use the token utilities, not raw colors.
- Don't add dependencies without need.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
