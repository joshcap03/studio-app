# Repository guide

This repository is the **Studio workspace**: a Next.js chat interface for the business
agent. The agent runs separately; this app never reimplements agent reasoning.

Earlier projects (the NY sales-tax agent and the Vite prototype) live in `archive/`, with
their own `archive/AGENTS.md`. Don't modify `archive/` unless the task is about it. Its
`data/`, `state/`, and `.env` hold real business data and secrets and stay gitignored.

## Commands

- `npm run dev`: dev server on http://127.0.0.1:3000 (reads `.env.local`)
- `npm run qa:serve`: isolated QA server on http://127.0.0.1:3100 with a throwaway password
  (`qa-local-only-password`, refused in production) and its own database `.data/qa.db`. Use
  this for browser automation; never use the owner's `.env.local` credentials.
- `npm run typecheck`, `npm test`, `npm run build`

Verify before handoff: typecheck, test, and build. For UI changes, drive the affected flow
on the QA server and report what you saw.

## Layout

- `src/app/`: routes. `(workspace)/[[...slug]]/page.tsx` serves `/` and `/c/<id>`;
  `login/`; `api/` (auth, conversations, streamed messages).
- `src/proxy.ts`: session gate for every page and API route except sign-in.
- `src/lib/agent/`: the agent boundary. `types.ts` is the event contract; `http.ts` is
  the real adapter (stub until the API contract is provided); `mock.ts` is the development agent.
- `src/lib/chat/turn.ts`: runs one turn (persist, stream, timeout, final state).
- `src/lib/db/`: SQLite via `node:sqlite` behind the `Store` interface.
- `src/lib/types.ts`: domain and stream types shared by browser and server.
- `src/components/`: `workspace/` (state owner), `chat/`, `sidebar/`, `ui/`.

## Rules

- Agent credentials and URLs stay server-side (`src/lib/config.ts`). Never send them to the
  browser, and never store credentials in localStorage.
- Every store query is scoped by user id; keep it that way.
- Render only what the backend reports: no invented activity steps, statuses, or artifacts,
  and no artifact parsing from free text. Mock output must stay clearly labeled.
- Do not invent the real agent API's endpoints or auth; ask for the contract.
- Navigation is client-side history with the path in `Workspace` state; don't switch
  conversations through Next router transitions.
- Design tokens live in `src/app/globals.css` (`:root` with a dark-mode override). Use the
  token utilities (`bg-surface`, `text-fg-2`, `border-line` …), not raw colors.
- Don't add dependencies without need. The stack is Next 16, React 19, Tailwind 4, Radix
  primitives (`radix-ui`), lucide-react, react-markdown, and zod.
