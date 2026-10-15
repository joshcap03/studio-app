# Development

How Studio is built, run, and deployed. For what Studio is, see the [README](../README.md).

The agent runs separately (Langflow today). This app is the product around it: accounts,
workspaces, conversations, streaming, execution activity, artifacts, memory, connected apps,
limits, and the tenant isolation that keeps businesses apart.

## Run it locally

Requires Node 22.13+, Docker (Colima works), and the Supabase CLI.

```bash
npm install
npm run db:start          # local Supabase: Postgres, Auth, REST (prints URL + anon key)
npm run db:reset          # apply migrations in supabase/migrations
cp .env.example .env.local  # fill NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev               # http://127.0.0.1:3000
```

Create an account at `/login`, set up a workspace, and start chatting. With
`AGENT_PROVIDER=mock` replies are simulated and labeled **Mock agent** throughout the UI.

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run qa:serve` | Dev server on :3000 / QA server on :3100 |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests: turn lifecycle, tenant scoping, Langflow protocol |
| `npm run test:integration` | Against local Supabase (+ QA server, + Langflow if configured): RLS, API isolation with two accounts, limits, live Langflow |
| `npm run build` / `npm start` | Production build / server |

## Architecture

```
browser ── Supabase session cookie ──▶ Next.js app ── tenant context ──▶ agent provider (Langflow)
            NDJSON event stream          │    │                          shared deployment
                                         │    └── Composio (per-member user ids)
                                         └── Supabase Postgres + Auth (RLS on every table)
```

- **Tenancy.** Workspaces are the tenant boundary (`workspaces`, `workspace_members`,
  `workspace_settings`). The MVP has one owner per workspace; membership roles are already
  modeled for teams. A person can belong to several workspaces and switch between them.
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
- **Memory.** Lives in Supermemory (`src/lib/memory.ts`), one namespace per workspace
  (shared) and one per member of a workspace (personal), both derived from the session; the
  agent and the browser never name one. Before each reply the app recalls the workspace's
  and the member's profile plus memories matching the message, and sends them with the run.
  When the agent calls `remember`, the app saves the fact at once and shows it under the
  reply with Undo; if saving fails, it stays a suggestion the member can save. Members manage
  memory in Settings. (The old `memories` table is no longer used.)
- **Approvals.** When the agent wants to change something (send, create, update, delete),
  the run pauses and the reply shows what it will do. Nothing runs until the member approves;
  a decline is passed to the agent. One undecided request per conversation; new messages
  wait for it. Retrying, editing, or deleting the conversation abandons it.
- **Files.** Members attach PDF, Word, CSV, text, and image files (10 MB, 5 per message).
  Bytes live in the private `attachments` Storage bucket under `<workspace>/<member>/`;
  only the owner can read them, and they're deleted with their conversation.
- **Edit and retry.** The latest message can be edited and answered again, and the latest
  reply retried. Both drop the replaced exchange from the provider's own memory too.
- **Limits.** Per-member messages per minute, concurrent runs, and per-workspace runs per
  day (counted in Postgres, so they hold across server instances); message, memory, and
  context size caps; three workspaces per account; Supabase Auth's own sign-up and sign-in
  rate limits.

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
     It also adds `remember`, whose structured result the app saves to the caller's memory.
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
   - **Load Skill** gets its code from `langflow/components/load_skill.py` (no business names).
   - A literal Exa key moves into the global variable `EXA_API_KEY`.
   - **Python REPL nodes are removed**: they execute in the Langflow server process, next
     to every tenant's keys. Keep them (`--keep-python`) only with `LANGFLOW_SANDBOX_BACKEND`
     configured on the server. Members' code runs in their own Composio workbench.
   - It prints the `LANGFLOW_TWEAKS` value to set, which fills the workspace context, Chat
     Input files, and Member Apps on every run.
   Use `--copy "Name" --strip-apps` to make a test copy with no app connections.
3. **Make the flow tenant-aware.** One shared flow serves every workspace, so it must take
   tenant-specific values from each request, never from hard-coded component settings:
   - `LANGFLOW_TWEAKS` maps per-run values onto component fields. Placeholders:
     `workspace_id`, `workspace_name`, `user_id`, `composio_user_id`, `composio_toolkits`
     (JSON `{slug: auth config id}`), `business_context`,
     `agent_instructions`, `memories`, `system_context`, and `files` (a value of exactly
     `"{{files}}"` becomes the uploaded file paths; without it, attachments are off).
     Runs also send `X-LANGFLOW-GLOBAL-VAR-*` headers, but Langflow 1.12 ignores them for
     background jobs, so anything the flow must read goes through tweaks.
   - Business specifics live in each workspace's settings and memory. The base prompt in
     Workspace Context and the skills must not name a business.
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

## Connected apps (Composio)

Set `COMPOSIO_API_KEY` (a Composio project key, the same one the flow's Member Apps node
uses) and `COMPOSIO_TOOLKITS`, with one auth config per app (Composio dashboard → Auth
Configs). Each
workspace member gets a stable, opaque Composio user id (`workspace_members.composio_user_id`);
connecting, listing, and disconnecting always use the caller's own id, and that same id is
sent to the agent on every run. One person's connections are never visible to, or usable
by, anyone else.

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

1. **Supabase.** Create a project, then `npx supabase link --project-ref <ref>` and
   `npx supabase db push`. In the dashboard:
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
   Supabase URL + anon key, `AGENT_PROVIDER=langflow`, the `LANGFLOW_*` values (tweaks
   from the installer), `COMPOSIO_*`, `SUPERMEMORY_API_KEY`, `AGENT_LIVE_WORKSPACES=*`, and
   **`LIMIT_RUNS_SERVICE_PER_DAY`** so open sign-ups can't run up the model bill. The chat
   route asks for 300 s (`maxDuration`), the Hobby ceiling; raise it on Pro.
4. **Composio.** Add the production URL to each auth config's allowed redirects; the connect
   flow returns to `/settings`.
5. **Smoke test.** Sign up with a fresh address, confirm, create a workspace, connect an
   app, and ask the agent something that uses it. Then sign up a second account and
   confirm it can't see the first one's apps.

## Limitations

- A run is tied to the browser request. Closing the tab stops it, and the message shows as
  interrupted with Retry. Cancellation in Langflow is best effort.
- One user per workspace in the UI. Invitations and roles beyond owner come next; the
  schema already supports them.
- Attached files are copied to Langflow under random names with the app's one Langflow key.
  Tenants can't name each other's files, but anyone holding that key could list them, so
  the key must stay server-side.
- Code runs in each member's Composio workbench. The shared flow has no in-process Python;
  the installer removes it unless the Langflow server has a sandbox backend.
- Shared, stateless tools (web search, the hosted browser) use one service account for
  everyone. Browser actions still need the member's approval.
