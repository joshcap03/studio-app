# Studio

A multi-tenant AI workspace for running a business. People sign up, create a workspace,
connect their own apps, and chat with a shared agent that works with *their* business
context, memory, and connections. Nothing about
any one business is built into the app or the agent integration.

The agent runs separately (Langflow today). This app is the product around it: accounts,
workspaces, conversations, streaming, execution activity, artifacts, memory, connected apps,
limits, and the tenant isolation that keeps businesses apart.

The previous projects (the NY sales-tax agent and the Vite prototype) are in
[`archive/`](archive/), tagged `archive/sales-tax-agent-2026-10-12`.

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
- **Memory.** `memories` rows are scoped to a workspace (shared) or a member (personal).
  Each run receives this workspace's memory plus the caller's personal memory, size-capped.
  The agent can suggest a memory; it's saved only when the member confirms it on the reply.
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
     always asks. Workbench code that calls a changing slug by name asks too. `take_action`
     refuses to run at all if the Agent has no approval checkpoint (nothing paused).
     It also adds `propose_memory`, whose structured result becomes a memory suggestion.
   - **Workspace Context** (`langflow/components/workspace_context.py`) holds the Agent's
     instructions and appends what the app sends per run.
   - It prints the `LANGFLOW_TWEAKS` value to set, which fills the workspace context and
     Chat Input files on every run.
   Use `--copy "Name" --strip-apps` to make a test copy with no app connections.
3. **Make the flow tenant-aware.** One shared flow serves every workspace, so it must take
   tenant-specific values from each request, never from hard-coded component settings:
   - Every run sends `X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID`, `…-WORKSPACE_ID`, and
     `…-USER_ID`. In the flow, set the Composio component's user/entity id field to the
     global variable `COMPOSIO_USER_ID` (create the variable in Langflow with any
     placeholder value; the request value overrides it).
   - `LANGFLOW_TWEAKS` maps per-run values onto component fields. Placeholders:
     `workspace_id`, `workspace_name`, `user_id`, `composio_user_id`, `business_context`,
     `agent_instructions`, `memories`, `system_context`, and `files` (a value of exactly
     `"{{files}}"` becomes the uploaded file paths; without it, attachments are off).
     Header global variables aren't applied to background jobs by Langflow 1.12, so prefer
     tweaks for anything the flow must read.
4. Session ids are always `<workspace_id>.<conversation_id>`, so Langflow's chat memory
   never mixes tenants. For defense in depth, also set `LANGFLOW_SERVING_END_USER_HEADER`
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

Set `COMPOSIO_API_KEY` (the same project your agent uses) and `COMPOSIO_TOOLKITS`. Each
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
  edit their messages, or save their memory suggestions; provider state never reaches the
  browser.

## Deploying

1. Create a Supabase project, run `supabase link` and `supabase db push`, and enable email
   confirmation (the `/auth/confirm` route handles the link).
2. Deploy the app (Vercel or any Node host). Set the env vars from `.env.example`.
3. Point Langflow and Composio at production credentials. The agent stays one shared deployment.

## Limitations

- A run is tied to the browser request. Closing the tab stops it, and the message shows as
  interrupted with Retry. Cancellation in Langflow is best effort.
- One user per workspace in the UI. Invitations and roles beyond owner come next; the
  schema already supports them.
- No file uploads yet: a shared Langflow API key would make uploaded files visible across
  tenants inside Langflow, so uploads need per-tenant storage first.
- Code execution happens inside the agent. The app passes workspace and member ids so
  sandboxes can be keyed per tenant, but isolating them is the agent deployment's job.
- The agent can read memory but can't write it yet: Langflow's API has no channel back to the app.
