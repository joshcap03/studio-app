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
  (run → stream of `thread`, `text-delta`, `message`, `activity`, `artifact` events; typed
  errors; abort) plus declared **capabilities** (streaming, cancellation mode, tool events,
  artifacts, run status). `langflow.ts` is the only Langflow-aware file; `mock.ts` is the
  development agent; `index.ts` picks one from `AGENT_PROVIDER`. Adding LangGraph or Deep
  Agents means adding one adapter and one `case`.
- **Turn runner** (`src/lib/chat/turn.ts`). Persists the user message, builds the tenant's
  agent context, streams events to the browser, checkpoints partial output with a heartbeat,
  enforces an idle timeout, and records the final state however the run ends.
- **Memory.** `memories` rows are scoped to a workspace (shared) or a member (personal).
  Each run receives this workspace's memory plus the caller's personal memory, size-capped.
- **Limits.** Per-member messages per minute, concurrent runs, and per-workspace runs per
  day (counted in Postgres, so they hold across server instances); message, memory, and
  context size caps; three workspaces per account; Supabase Auth's own sign-up and sign-in
  rate limits.

## Connecting Langflow

Verified against Langflow 1.12.5. The adapter calls `POST /api/v1/run/{flow}` (streaming
when `LANGFLOW_STREAM` is on) with your API key, and translates Langflow's events: `token`
→ streamed text, bot `add_message` → the reply and its `tool_use` steps as activity,
`error` → a readable failure, `end` → completion. Stopping closes the connection, which
cancels the run in Langflow (best effort).

1. Set `AGENT_PROVIDER=langflow`, `LANGFLOW_BASE_URL`, `LANGFLOW_API_KEY`, `LANGFLOW_FLOW_ID`.
2. **Make the flow tenant-aware.** One shared flow serves every workspace, so it must take
   tenant-specific values from each request, never from hard-coded component settings:
   - Every run sends `X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID`, `…-WORKSPACE_ID`, and
     `…-USER_ID`. In the flow, set the Composio component's user/entity id field to the
     global variable `COMPOSIO_USER_ID` (create the variable in Langflow with any
     placeholder value; the request value overrides it).
   - To give the agent the workspace's instructions, business context, and memory, use
     `LANGFLOW_TWEAKS` to map them onto component fields, e.g.
     `{"Agent-AbCdE":{"system_prompt":"{{system_context}}"}}`. Available placeholders:
     `workspace_id`, `workspace_name`, `user_id`, `composio_user_id`, `business_context`,
     `agent_instructions`, `memories`, `system_context`.
3. Session ids are always `<workspace_id>.<conversation_id>`, so Langflow's chat memory
   never mixes tenants. For defense in depth, also set `LANGFLOW_SERVING_END_USER_HEADER`
   and `LANGFLOW_SERVING_TRUST_PROXY_HEADERS=true` on the Langflow server and the same header
   name in `LANGFLOW_END_USER_HEADER` here.
4. **Artifacts** render only from structured tool output that declares one:
   `{"artifact": {"id", "kind", "title", "url", "description"?, "source"?}}` (https links
   only). Links in plain text never become cards.

5. **Work markers.** Code the agent runs (e.g. Composio workbench scripts) can report
   progress and files explicitly by printing lines that start with these markers:
   ```
   STEP Fetched 95 products from shop.example
   ARTIFACT {"id": "…", "kind": "spreadsheet", "title": "…", "url": "https://…", "description": "…", "source": "Google Sheets"}
   ```
   `STEP` lines become a checklist in that step's receipt; `ARTIFACT` lines become file
   cards (https only, validated). Nothing else in tool output is interpreted.

Not used because Langflow's `/run` API doesn't provide it: polling run status
(`capabilities.runStatus` is false).

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
