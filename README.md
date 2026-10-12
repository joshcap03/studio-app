# Studio workspace

A private, chat-first workspace for a business's agent. The agent itself runs
separately; this app is the interface on top of it: conversations, streaming replies, live
execution activity, and artifact cards for files the agent creates.

The previous projects (the NY sales-tax agent and the Vite prototype) are archived under
[`archive/`](archive/) and tagged in git as `archive/sales-tax-agent-2026-10-12`.

## Run it locally

Requires Node 22.13 or newer (SQLite storage uses Node's built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local   # then set APP_PASSWORD and SESSION_SECRET
npm run dev                  # http://127.0.0.1:3000
```

Sign in with `APP_PASSWORD`. With `AGENT_ADAPTER=mock` (the default) every reply comes from a
built-in development agent and is labeled **Mock agent** in the header, sidebar, and below
the composer. Try *Analyze my inventory*, *Create a spreadsheet of orders*, *Research a
competitor*, *Run a long reconciliation*, *Simulate a failure*, or add *non-streaming* to a
message to exercise each path.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on 127.0.0.1:3000 |
| `npm run qa:serve` | Isolated QA server on 127.0.0.1:3100 with a throwaway password and its own database (`.data/qa.db`), for browser automation |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit tests (session signing, turn lifecycle, storage, adapters) |
| `npm run build` / `npm start` | Production build and server on port 3000 |

## Configuration

All configuration is server-side environment variables; nothing reaches the browser.
See [`.env.example`](.env.example) for the full list.

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_PASSWORD` | yes | The password that unlocks the workspace (12+ characters) |
| `SESSION_SECRET` | yes | Signs session cookies (32+ random characters) |
| `AGENT_ADAPTER` | no | `mock` (default) or `http` |
| `AGENT_API_URL` | for `http` | Base URL of your agent API |
| `AGENT_API_KEY` | for `http` | Credential for your agent API |
| `AGENT_IDLE_TIMEOUT_MS` | no | Fail a run after this long with no events (default 120000) |
| `MOCK_STREAMING` | no | `false` makes the mock reply in one piece |
| `DATABASE_PATH` | no | SQLite file (default `.data/workspace.db`) |

## Connecting your agent

Everything agent-specific lives in [`src/lib/agent/`](src/lib/agent/):

- `types.ts` is the contract. An adapter's `run()` receives `{ threadId, message, history,
  signal }` and yields events:
  - `thread`: the backend's conversation id (stored and sent back on the next turn)
  - `text-delta` (streaming) or `message` (whole reply, non-streaming)
  - `activity`: a step with `id`, `label`, and `running | done | failed`; re-emit the id to update it
  - `artifact`: `{ id, kind, title, description?, source?, url? }` for files and links it created
- `http.ts` is the real adapter. It is a stub that fails clearly until the API contract
  is filled in; its header comment shows where each piece of the protocol maps.
- `mock.ts` is the development agent, built against the same interface.

To finish the connection I need, from your agent API:

1. The base URL and how requests authenticate (header name and scheme)
2. The request payload for a turn (and whether it takes a thread id or full history)
3. The response format: a single JSON reply, SSE, NDJSON, or another stream; plus examples
   of text, tool-call, and file/artifact events
4. How thread or conversation ids are created and returned

Then set `AGENT_ADAPTER=http`, `AGENT_API_URL`, and `AGENT_API_KEY`. The UI needs no changes.
Only events the backend actually sends are shown: no invented steps, statuses, or artifacts.

## Architecture

```
browser ──(httpOnly session cookie)──▶ Next.js app ──(server-only credentials)──▶ agent API
          NDJSON stream of events          │
                                           └── SQLite: users, conversations, messages
```

- **UI** (`src/components/`): `workspace/` owns client state and in-flight runs (a
  conversation keeps streaming while you read another); `chat/` holds the composer, thread,
  markdown, activity log, and artifact card; `sidebar/` holds history, search, rename, and delete.
- **API routes** (`src/app/api/`): auth, conversation CRUD, and
  `POST /api/conversations/:id/messages`, which starts a turn and streams events.
- **Turn runner** (`src/lib/chat/turn.ts`): persists the user message, drives the adapter
  with an idle timeout, saves partial output as it streams, and records the final state
  however the run ends (complete, error, stopped, or interrupted).
- **Storage** (`src/lib/db/`): one `Store` interface over SQLite. Every query is scoped by
  user id, so multi-user accounts are a matter of real sign-in, not a schema change.
- **Auth** (`src/proxy.ts`, `src/lib/auth/`): one password, HMAC-signed httpOnly session
  cookie (30 days), checked in the proxy and again in every route. State-changing requests
  must be same-origin. Failed sign-ins are throttled.

**Why SQLite:** zero setup and no extra service, conversations survive restarts, and it is
fast for one business. The tradeoff: it needs a persistent disk, so it fits a VM, Fly.io,
Railway, or Render with a volume, but not serverless hosts with ephemeral filesystems. Moving
to Postgres means reimplementing `src/lib/db/store.ts` only.

## Deploying

1. Pick a host with a persistent volume (for example Fly.io, Railway, Render, or a small VM).
2. Set `APP_PASSWORD`, `SESSION_SECRET`, the agent variables, and `DATABASE_PATH` pointing
   into the volume.
3. Build and start: `npm ci && npm run build && npm start` (listens on port 3000; put TLS in
   front). Session cookies are marked `Secure` behind HTTPS.
4. Serve it over HTTPS only. The app is a private, write-capable interface to your business
   agent, so keep the password strong and rotate `SESSION_SECRET` to sign everyone out.

## Limitations

- A run is tied to the browser request: closing the tab or restarting the server stops it,
  and the message is shown as interrupted with a Retry button. Resuming detached runs would
  need the agent API to support it.
- Single user with one shared password; there are no per-user accounts yet.
- No file uploads, since the composer only shows capabilities the backend supports. Add
  them once the agent API accepts files.
- Sign-in throttling is in memory, per server process.
