# Development

How Studio is built, run, and deployed. For what Studio is, see the [README](../README.md).

The agent runs separately (Langflow today). This app is the product around it: accounts,
agents and their templates and setup, conversations, streaming, execution activity,
artifacts, memory, connected apps, tasks and the background worker, voice calls, limits, and
the tenant isolation that keeps people apart.

In code and the database an agent is a `workspace`; the UI only ever says "agent".

## Run it locally

Requires Node 22.13+, Docker (Colima works), and the Supabase CLI.

```bash
npm install
npm run db:start          # local Supabase: Postgres, Auth, REST (prints URL + anon key)
npm run db:reset          # apply migrations in supabase/migrations
cp .env.example .env.local  # fill NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev               # http://127.0.0.1:3000
```

Create an account at `/login`, create an agent, and start chatting. With
`AGENT_PROVIDER=mock` replies are simulated and labeled **Mock agent** throughout the UI.

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run qa:serve` | Dev server on :3000 / QA server on :3100 |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests: turn lifecycle, tenant scoping, Langflow protocol |
| `npm run test:integration` | Against local Supabase (+ QA server, + Langflow if configured): RLS, API isolation with two accounts, limits, live Langflow |
| `npm run test:audit` | Replays every tool call in the flow's real history and fails on missing or technical step text (needs `LANGFLOW_AUDIT_*`) |
| `npx trigger.dev dev` | The background worker, locally (needs a Trigger.dev login and `TRIGGER_PROJECT_REF`) |
| `npm run build` / `npm start` | Production build / server |

## Architecture

```
browser ── Supabase session cookie ──▶ Next.js app ── tenant context ──▶ agent provider (Langflow)
            NDJSON event stream          │  │  │  │                       shared deployment
                                         │  │  │  └── Composio (one user id per person)
                                         │  │  └── Supermemory (namespaced per agent / person)
                                         │  └── Supabase Postgres + Auth + Storage (RLS everywhere)
                                         │
Trigger.dev worker ── member's session ──┘   (POST /api/tasks/<id>/runs/<run>)
ElevenLabs voice ── sealed call context ──▶ /api/voice/llm/v1/chat/completions
```

- **Tenancy.** An agent (`workspaces`, `workspace_members`, `workspace_settings`) is the
  tenant boundary. One login holds several agents and switches between them; each keeps its
  own name, template, profile, instructions, chats, tasks, skills, files, and shared memory.
  What's about the person is shared by all their agents: the account (`accounts`: name,
  "about you", Composio id) and personal memory. The UI has one owner per agent; membership
  roles are already modeled for teams.
- **Identity.** User and workspace come only from the authenticated Supabase session. The
  active workspace is a preference cookie that is honored only after a membership check.
- **Data isolation, twice.** The app queries Postgres *as the signed-in user*, so Row Level
  Security applies to every request, and every query also filters by workspace and user.
  Composite foreign keys stop rows from being attached to another tenant's conversation.
  There is no service-role key in the app.
- **Visibility.** Workspace settings and shared memory are visible to members.
  Conversations, messages, personal memory, usage rows, and each member's Composio id are
  private to that member.
- **Agent boundary** (`src/lib/agent/`). `types.ts` defines one provider-neutral interface
  (run → stream of `thread`, `text-delta`, `message`, `activity`, `artifact`, `approval`,
  `memory-proposal` events; resume; typed errors; abort) plus declared **capabilities**
  (streaming, cancellation mode, tool events, artifacts, run status, approvals, attachments,
  rewind). `langflow.ts` is the only Langflow-aware file; `mock.ts` is the
  development agent; `index.ts` picks one from `AGENT_PROVIDER`. Adding LangGraph or Deep
  Agents means adding one adapter and one `case`.
- **Turn runner** (`src/lib/chat/turn.ts`). Persists the user message, builds the tenant's
  agent context, streams events to the browser, checkpoints partial output with a heartbeat,
  enforces an idle timeout, and records the final state however the run ends.
- **Memory.** Lives in Supermemory (`src/lib/memory.ts`): `ws_<workspace>` for an agent's
  shared facts and `u_<user>` for the person's own, shared by all their agents. Both are
  derived from the session; the agent and the browser never name one. Before each reply the
  app recalls the agent's and the person's profile plus memories matching the message, and
  sends them with the run.
  When the agent calls `remember`, the app saves the fact at once and shows it under the
  reply with Undo; if saving fails, it stays a suggestion the member can save. Members manage
  memory in Settings. "Tidy up" on a Brain topic starts a chat with that topic's tidy skill
  (`src/lib/skills/tidy.ts`), which lists the facts the member may change by id; the agent
  proposes combining overlapping ones with `merge_memories`. The app checks each id against
  memory under the member's session (`src/lib/memory-merge.ts`) and shows the merges as a card.
  Merging saves the new fact (pinned if any original was, with the newest source) before
  removing the originals, never mixes shared facts with personal ones, and lets a member change
  only shared facts they saved (an owner, any). Undo restores the originals. (The old `memories` table is no longer used.)
- **Approvals.** When the agent wants to change something (send, create, update, delete),
  the run pauses and the reply shows what it will do. Nothing runs until the member approves;
  a decline is passed to the agent. One undecided request per conversation; new messages
  wait for it. Retrying, editing, or deleting the conversation abandons it.
- **Files.** Members attach PDF, Word, CSV, text, and image files (10 MB, 5 per message).
  Bytes live in the private `attachments` Storage bucket under `<workspace>/<member>/`;
  only the owner can read them, and they're deleted with their conversation. A member can
  also keep files on an agent's page (`src/lib/agent-files.ts`, a résumé, say); those go
  with every run of that agent, ahead of project files.
- **Templates and setup** (`src/lib/templates/`). Job search, Small business, Sales pipeline,
  Inbox & calendar, Content & social, and Start from scratch. Applying one copies its instructions and library skills into the agent without
  overwriting anything, gives the member its tasks (paused), and suggests apps (never
  connected automatically). Every template has a setup interview that the built-in setup
  skill (`src/lib/skills/setup.ts`) runs: discovery, defining success, gathering context, a
  trial run the member judges, the agent's plan for the job run by the member for their advice,
  and finally a `propose_agent` card the owner applies. Its
  progress is `workspace_settings.setup` (`src/lib/setup-state.ts`).
- **Agent-rendered UI.** Cards are reusable gateway tools any skill can call, never UI for
  one flow: `ask_user` (choices, ranking, scale, keep/pass verdicts, "Something else"),
  `show_form`, `propose_agent`, and `merge_memories` (`src/components/chat/ui-cards.tsx`, `requests.tsx`).
  They change nothing themselves: a form's answers go out as the member's next message, and
  a proposal applies only when the member clicks Apply. Keep/pass calls are saved as the
  member's verdicts (`src/lib/verdicts.ts`).
- **Plans** (`src/lib/journey.ts`). Any work with several steps gets a plan the agent keeps with
  `update_plan`, with what done looks like: on its task, in the setup checklist (while the
  interview is under way in that conversation), or on the conversation (`conversations.plan`).
  The member sees it as the rail above the chat, and can clear a conversation's own from there.
- **Tasks** (`src/lib/tasks/`). A task has a goal, a plan the agent keeps with `update_plan`,
  a schedule (`schedule.ts`: daily, weekdays, weekly, or every N hours, in the member's time
  zone), a linked conversation, and runs. The agent keeps a tracker of records per collection
  with `save_record` (`records.ts`). Tasks are private to their member. "Run now" and the
  worker both start a run through `run-task.ts`, as the member.
- **Background worker** (`trigger/`). Every two minutes `dispatch.ts` claims due tasks and
  `run-task.ts` signs in as each task's member and asks the app to run it (`POST
  /api/tasks/<id>/runs/<run>`), so runs use the app's settings and keys. The worker holds only
  the Supabase keys and `APP_URL`; `trigger/lib/elevated.ts` is the only code with the
  Supabase secret key, and `src/lib/elevated-guard.test.ts` keeps it that way. It deploys
  from GitHub Actions after each Vercel production deploy.
- **Notifications** (`src/lib/push.ts`, `public/sw.js`). Web Push to a member's devices when a
  run ends or needs approval while they aren't watching. Studio installs as a home-screen app
  (`src/app/manifest.ts`).
- **Voice calls** (preview, `src/lib/voice/`). A fast voice in front of the same agent; see
  [voice.md](voice.md).
- **Ratings.** Thumbs up/down on a reply, with optional reasons, are stored and, with
  `LANGSMITH_API_KEY`, attached to the run's LangSmith trace as `user_rating` feedback.
- **Preview features** (`src/lib/flags.ts`) switch on only for the sign-in emails in
  `PREVIEW_FEATURE_EMAILS`: Business Brain (sharing personal memories with an agent, owner
  approved), `/why` investigations (with charts, key numbers, and tables), and voice
  (`PREVIEW_VOICE_EMAILS` adds voice alone).
- **Edit and retry.** The latest message can be edited and answered again, and the latest
  reply retried. Both drop the replaced exchange from the provider's own memory too.
- **Limits.** Per-member messages per minute, concurrent runs, per-agent runs and task runs
  per day, and a service-wide daily cap (counted in Postgres, so they hold across server
  instances); voice time per person per day; message, memory, and context size caps; three
  agents per account; Supabase Auth's own sign-up and sign-in rate limits.

## Connecting Langflow

Verified against Langflow 1.12.4. Each turn starts a background job (`POST /api/v2/workflows`,
`mode: "background"`) and reads its events (`GET /api/v2/workflows/{job}/events`), which
Langflow keeps even if the connection drops. Events translate as: `token` → streamed text,
bot `add_message` → the reply and its `tool_use` steps as activity, `human_input_required`
→ an approval (the job is suspended), `error` → a readable failure, `end` → completion.
A decision resumes the job (`POST /api/v2/workflows/{job}/resume`); Stop cancels it
(`POST /api/v2/workflows/stop`). Attached files are uploaded to Langflow under random names
(`POST /api/v2/files`) and passed to the Chat Input. Retry and edit delete the replaced
exchange from the session's stored messages.

1. Set `AGENT_PROVIDER=langflow`, `LANGFLOW_BASE_URL`, `LANGFLOW_API_KEY`, `LANGFLOW_FLOW_ID`.
2. **Install the Studio components** into the flow (it must have an Agent, a Tool Gateway,
   and a Chat Input). This backs the flow up to `langflow/backup-*.json`, then updates it:
   ```
   LANGFLOW_BASE_URL=… LANGFLOW_API_KEY=… python3 langflow/install.py <flow-id>
   ```
   - The **Tool Gateway** (`langflow/components/tool_gateway.py`) refuses changes through
     `execute_tool` and routes them to `take_action`, which carries Langflow's tool-approval
     metadata, so the Agent pauses before it runs. Composio actions count as changes unless
     their slug only reads (GET, LIST, FETCH, SEARCH, …); unknown verbs ask. Browser `act`
     always asks. Workbench and bash code always asks, since code can build slugs or call any
     API at runtime. Composio's own meta tools (connections, skills, feedback) ask unless
     they're lookups (search, schemas, waiting for a connection). `take_action`
     refuses to run at all if the Agent has no approval checkpoint (nothing paused).
     It also adds `remember`, whose structured result the app saves to the caller's memory,
     and the card tools (`ask_user`, `show_form`, `propose_agent`, `merge_memories`), which
     change nothing themselves.
     The installer removes any Supermemory MCP node from the flow: one connection would be
     shared by every workspace, so memory goes through the app instead.
   - **Workspace Context** (`langflow/components/workspace_context.py`) holds the Agent's
     instructions and appends what the app sends per run.
   - **Member Apps** (`langflow/components/composio_member.py`) replaces any shared Composio
     MCP node. Per run it opens a Composio tool-router session for the calling member's id
     only, limited to the apps in `COMPOSIO_TOOLKITS`, and returns no app tools without a
     valid member id. It reads the Langflow global variable `COMPOSIO_API_KEY`, which must
     be the Composio **project** key (`ak_…`) the app uses, not a consumer key (`ck_…`).
     Connecting apps happens in Settings, not in chat.
   - **Studio Browser** (`langflow/components/studio_browser.py`) replaces any shared
     Browserbase MCP node. Browserbase's hosted server keeps one browser per MCP connection and
     Langflow reuses one connection per URL and key, so a shared node put every tenant in the
     same browser. Studio Browser opens a connection per conversation (a header hashed from
     the session id, which survives an approval resume), binds the browser `start` returns to
     that conversation and passes it on every call (the model never sets `sessionId`), and
     drops the signed `cdpUrl` from results. It sends the same credential header and Langflow
     global variable the shared node used. If the plan's concurrent browsers are all in use,
     `start` ends this process's longest-idle browser (a minute or more) and tries once more.
     With `context_id` filled per run (`{{browser_context}}`, the member's saved sign-ins: one
     Browserbase context per person, made by the app), it opens each conversation's browser
     itself through Browserbase's API with that context, persisted, and hands the session to
     `start`, so a site the member signed in to (after the agent handed them its browser with
     `hand_browser`) stays signed in. Without it, browsers open signed out as before.
   - **Load Skill** gets its code from `langflow/components/load_skill.py` (no business names).
   - A literal Exa key moves into the global variable `EXA_API_KEY`, and Exa search returns
     at least 10 results (the node's count is fixed per flow; the agent can't raise it per call).
   - **Python REPL nodes are removed**: they execute in the Langflow server process, next
     to every tenant's keys. Keep them (`--keep-python`) only with `LANGFLOW_SANDBOX_BACKEND`
     configured on the server. Members' code runs in their own Composio workbench.
   - It prints the `LANGFLOW_TWEAKS` value to set, which fills the workspace context, Chat
     Input files, Member Apps, and Studio Browser's saved sign-ins on every run.
   Use `--copy "Name" --strip-apps` to make a test copy with no app connections.
3. **Make the flow tenant-aware.** One shared flow serves every workspace, so it must take
   tenant-specific values from each request, never from hard-coded component settings:
   - `LANGFLOW_TWEAKS` maps per-run values onto component fields. Placeholders:
     `workspace_id`, `workspace_name`, `user_id`, `composio_user_id`, `composio_toolkits`
     (JSON `{slug: auth config id}`), `agent_profile` (alias `business_context`),
     `agent_instructions`, `memories`, `project_name`, `project_instructions`,
     `personal_guardrail`, `system_context`, `browser_context` (the member's saved sign-ins
     for Studio Browser's `context_id`; empty when browsing is off), and `files` (a value of exactly
     `"{{files}}"` becomes the uploaded file paths; without it, attachments are off).
     Runs also send `X-LANGFLOW-GLOBAL-VAR-*` headers, but Langflow 1.12 ignores them for
     background jobs, so anything the flow must read goes through tweaks.
   - Workspace specifics (a business, a job search, anything) live in each workspace's
     settings and memory. The base prompt in Workspace Context and the skills must not name
     a business, person, or use case.
   - Only then set `AGENT_LIVE_WORKSPACES=*`. Until the flow is tenant-aware, keep it to the
     workspace ids the flow was built for.
4. Session ids are always `<workspace_id>.<member composio id>.<conversation_id>`, so
   Langflow's chat memory never mixes tenants. The member id is there because Langflow
   1.12 drops tweaks when a run resumes after an approval but keeps the session id;
   Member Apps reads it then. For defense in depth, also set `LANGFLOW_SERVING_END_USER_HEADER`
   and `LANGFLOW_SERVING_TRUST_PROXY_HEADERS=true` on the Langflow server and the same header
   name in `LANGFLOW_END_USER_HEADER` here. (Rewind isn't claimed with an end-user header:
   it hasn't been verified against the scoped session ids.)
5. **Artifacts** render only from structured tool output that declares one:
   `{"artifact": {"id", "kind", "title", "url", "description"?, "source"?}}` (https links
   only). Links in plain text never become cards.

6. **Work markers.** Code the agent runs (e.g. Composio workbench scripts) can report
   progress and files explicitly by printing lines that start with these markers:
   ```
   STEP Fetched 95 products from shop.example
   ARTIFACT {"id": "…", "kind": "spreadsheet", "title": "…", "url": "https://…", "description": "…", "source": "Google Sheets"}
   ```
   `STEP` lines become a checklist in that step's receipt; `ARTIFACT` lines become file
   cards (https only, validated). Nothing else in tool output is interpreted.

Not used yet: polling job status after the fact (`capabilities.runStatus` is false).

The live tests in `tests/integration/langflow.test.ts` also run against a flow with the
Studio components when `LANGFLOW_TEST_GATEWAY_FLOW_ID` is set (use a `--strip-apps` copy):
pause, decline, a stale decision, reading an attached file, and rewind.
With `LANGFLOW_TEST_BROWSER_FLOW_ID` (a flow with Studio Browser, a real model, and a
Browserbase key with two free concurrent browsers), two conversations browse at once and must
get different browsers, and no signed connection URL may appear in either run.

## Connected apps (Composio)

Set `COMPOSIO_API_KEY` (a Composio project key, the same one the flow's Member Apps node
uses) and `COMPOSIO_TOOLKITS`, with one auth config per app (Composio dashboard → Auth
Configs). Each
person gets one stable, opaque Composio user id (`accounts.composio_user_id`), so all their
agents see the same connected apps; connecting, listing, and disconnecting always use the
caller's own id, and that same id is sent to the agent on every run
(`workspace_members.composio_user_id` is legacy). One person's connections are never visible
to, or usable by, anyone else.

## Isolation tests

`npm run test:integration` creates independent accounts and attempts cross-tenant access:

- **Database (RLS):** reads, inserts, updates, deletes, moving rows between workspaces,
  spoofing ownership columns, joining another workspace, and calling RPCs for another
  workspace, all directly through PostgREST with a valid session.
- **API:** another tenant's conversation id on every verb, retry and send into it, forged
  active-workspace cookie, switching into a foreign workspace, deleting foreign memory,
  overwriting foreign settings, unauthenticated and cross-origin requests.
- **Limits:** concurrent runs and runs per minute.
- **Langflow:** two tenants with the same conversation id land in different Langflow
  sessions, and each one's history contains only its own messages.
- **Approvals, files, suggestions:** another tenant can't read, answer, or forge an approval,
  read or plant files in another member's Storage folder, claim another member's upload,
  edit their messages, or undo or save their memories; provider state never reaches the
  browser.

## Deploying (Vercel + Supabase Cloud)

The step-by-step version, with every env var and the background worker, is
[deploy-checklist.md](deploy-checklist.md). Voice calls are in [voice.md](voice.md).

1. **Supabase.** Create a project and a personal access token (Account → Access Tokens).
   Production builds run `scripts/migrate-production.mjs`, which applies
   `supabase/migrations` before `next build`, so a deploy never goes live ahead of its
   schema and a failed migration fails the deploy. Keep migrations backward-compatible:
   the previous deployment serves against the new schema until the build finishes. In the
   dashboard:
   - Authentication → Sign In / Providers → Email: keep sign-ups on, turn **Confirm email** on.
   - Authentication → URL Configuration: Site URL = the app's production URL (the email
     links are built from it); add it under Redirect URLs too.
   - Authentication → Emails → Templates: paste `supabase/templates/confirmation.html` into
     "Confirm signup" and `recovery.html` into "Reset password". The defaults use a
     redirect flow `/auth/confirm` doesn't accept.
   - Authentication → Emails → SMTP: set up a real sender (Resend, Postmark, SES…). The
     built-in sender only reaches your team's addresses and a few emails an hour.
2. **Langflow.** Follow [`langflow/deploy/README.md`](../langflow/deploy/README.md): deploy the
   container (Railway or Render blueprint, managed Postgres, ≥1 GB RAM), create an API key,
   copy the flow with `export_flow.py`, run `langflow/install.py` against it, and create the
   global variables it reads. Only the app should call this server.
3. **Vercel.** Import the repo. Set the env vars from `.env.example` for Production:
   Supabase URL + anon key, `SUPABASE_ACCESS_TOKEN`, `AGENT_PROVIDER=langflow`, the `LANGFLOW_*` values (tweaks
   from the installer), `COMPOSIO_*`, `SUPERMEMORY_API_KEY`, `AGENT_LIVE_WORKSPACES=*`, and
   **`LIMIT_RUNS_SERVICE_PER_DAY`** so open sign-ups can't run up the model bill. The chat
   route asks for 300 s (`maxDuration`), the Hobby ceiling; raise it on Pro.
4. **Composio.** Add the production URL to each auth config's allowed redirects; the connect
   flow returns to `/settings`.
5. **Smoke test.** Sign up with a fresh address, confirm, create an agent, connect an
   app, and ask the agent something that uses it. Then sign up a second account and
   confirm it can't see the first one's apps.

## Limitations

- A chat run streams inside its request and keeps going if the member closes the app, up to
  the route's `maxDuration` (300 s on Vercel Hobby); a run cut off there shows as interrupted
  with Retry. Cancellation in Langflow is best effort.
- One person per agent in the UI. Invitations and roles beyond owner come next; the
  schema already supports them.
- Attached files are copied to Langflow under random names with the app's one Langflow key.
  Tenants can't name each other's files, but anyone holding that key could list them, so
  the key must stay server-side.
- Code runs in each member's Composio workbench. The shared flow has no in-process Python;
  the installer removes it unless the Langflow server has a sandbox backend.
- Shared, stateless tools (web search, the hosted browser) use one service account for
  everyone. Browser actions still need the member's approval.
