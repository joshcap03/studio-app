# Repository guide

This repository hosts two projects:

- **NY Sales Tax Agent** (`agent/`) — the deterministic quarterly ST-100 filing agent
  (engine, assistant page on 127.0.0.1:8787, proactive scheduler/notifications). See the
  dedicated section below, `agent/README.md`, `DECISIONS.md`, `WALKTHROUGH.md`, and
  `PROGRESS.md`.
- **Studio prototype** (root `src/`) — the mobile-first React SPA described
  next. The agent mission leaves it untouched.

## What this project is

Studio: a mobile-first React SPA that tracks jewelry studio money — vendor
receipts, items/materials, designs and pieces, and sales with profit. It is a
front-end-only prototype: no backend, no API calls, no persistence. All data is seed data
held in React state, so every reload starts from the same known state.

Stack: Vite 8, React 19, TypeScript 7 (strict), lucide-react icons, plain CSS. No router,
no state library, no CSS framework.

## Commands

- Install dependencies: `npm ci` (or `npm install` when changing dependencies)
- Start dev server: `npm run dev` → http://localhost:5173
- Type check: `npm run typecheck`
- Run tests once: `npm test`
- Watch tests: `npm run test:watch`
- Build (type check + bundle to `dist/`): `npm run build`
- Serve the build: `npm run preview`
- Scripted QA: `npm run qa:serve` (fixed 127.0.0.1:5173) or `npm run build && npm run qa:preview` (fixed 127.0.0.1:4173)

Use `qa:serve` / `qa:preview` when an automated check needs a deterministic URL and port;
use `dev` for normal human work.

## Project layout

- `src/main.tsx` — the entire app: shared types, seed data, every screen component,
  `App` (which owns all state and switches screens), and the `createRoot` render call.
- `src/styles.css` — all styling. Class-based, mobile-first, designed around the
  `.phone` shell in `main.tsx`.
- `src/app.smoke.test.tsx` — boot smoke test; it imports the real entry point.
- `index.html` — Vite entry; contains only the `#root` div.
- `vite.config.ts` — build/dev server config. `vitest.config.ts` — test config (jsdom).
- `dist/` — build output, generated, git-ignored. Never edit by hand.

## How the app works

- `App` in `src/main.tsx` holds every piece of state: `screen`, `purchases`, `pieces`,
  `items`, plus detail-screen selections. `go(name)` switches screens in memory. There is
  no URL routing and nothing is persisted.
- First screen is `signin`, unless the page loads at `/states`, which shows the review
  screen with direct links to each state.
- Screen names: `signin`, `home`, `receipt`, `items`, `new-item`, `pieces`, `new-piece`,
  `piece`, `sold`, `account`, `states`. Any other value falls through to `states`.
- Sign-in is fake: `Continue` reveals a 6-digit code field, `Sign in` goes to `home`.
  Nothing is validated and no request is made.
- Domain types live at the top of `src/main.tsx`. Cost types are exactly
  `Stones | Metal | Casting | Setting | Other`. Pieces have `status` in
  `In progress | Available | Sold | Archived` and a `kind` of `Design | Piece | Custom`.
  Money is stored as a number and rendered through the `money()` helper.
- Screens are wired through `index.html`'s `#root` and rendered by `createRoot`.

## Conventions

- `src/main.tsx` deliberately uses dense one-line component definitions. Match that style
  for small additions to the file, and never reformat existing lines or the file as a
  whole.
- Put larger new features in new modules under `src/` (for example `src/screens/*.tsx`)
  and wire them into `App` from `main.tsx`, rather than growing `main.tsx` indefinitely.
- All styling goes in `src/styles.css` using class names; keep the `phone` shell, the
  bottom nav, and the existing summary-row/list patterns intact unless the task says
  otherwise.
- Reuse the existing helpers (`money()`, `Row`, `photoClass()`, `nav()`, `shell()`) instead
  of introducing parallel ones.
- Icons come from `lucide-react`. Do not add a UI kit, CSS framework, or router.
- Do not add a dependency unless the existing stack cannot solve the problem.

## Testing rules

- `npm test` runs vitest with the jsdom environment; tests are `src/**/*.test.tsx`.
- `src/app.smoke.test.tsx` imports `src/main.tsx` directly, so it exercises the real
  `createRoot(<App />)` boot path. Keep it passing; it is the fastest signal that the app
  still mounts.
- Add a focused test next to the feature you change, and keep tests free of
  `console.error` output.
- Tests must not depend on wall-clock time or timers where avoidable; where the UI waits
  on a `setTimeout`, assert on the resulting state instead of sleeping.

## Verification

Before calling work finished, run:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

Fix failures and rerun. For UI changes, also start the app and confirm the affected screen
renders and navigates, and capture what you observed in your summary.

## QA and user-flow validation

Missions validate features by driving the app like a user. Use this path:

1. Start a deterministic server: `npm run qa:serve` (http://127.0.0.1:5173) or, for the
   production bundle, `npm run build && npm run qa:preview` (http://127.0.0.1:4173).
2. Redirect logs when you need to inspect startup output, for example
   `npm run qa:serve > /tmp/studio-dev.log 2>&1 &`.
3. Drive the UI with browser automation. Because nothing persists, a reload always returns
   to a known state, so flows are repeatable.
4. For a specific blank state, load `/states` and pick the state, or navigate the normal
   flow: `Continue` → `Sign in` → the screen under test.

## Generated files

- `dist/` and `*.tsbuildinfo` are build output.
- `tsc -b` also emits `vite.config.js` and `vite.config.d.ts` next to `vite.config.ts`
  (see `tsconfig.node.json`). These are generated and git-ignored. Edit `vite.config.ts`,
  never the emitted files.

## Safety

- Never commit secrets, credentials, or real customer/vendor data. Seed data in
  `src/main.tsx` is fictional and must stay fictional.
- There is no backend and no network access in the app; do not add calls to real services
  without an explicit task to do so.
- Do not run destructive commands (recursive deletes, `git reset --hard`, `git clean`) or
  rewrite git history without explicit approval.
- Keep changes scoped to the requested feature; do not reformat or restructure unrelated
  code.

## NY Sales Tax Agent (`agent/`)

The agent is a separate Node ≥ 22.18.0 / strict-TypeScript package. Run everything from
the repository root with `npm --prefix agent …`; internals are documented in
`agent/README.md`.

### Commands

- Verify before handoff, in order: `npm --prefix agent run typecheck`,
  `npm --prefix agent run lint`, `npm --prefix agent test`,
  `npm --prefix agent run backtest`, and the relevant
  `npm --prefix agent run experience:m1|m2|m3|m4|m6|m7`. `experience:m7` is the conversational
  router slice ("hello" gets a conversation and no run; an explicit ask on the just-closed
  quarter starts the run with one batched ask; run mechanics stay in the collapsed Activity; the
  m7 milestone gate runs it). `npm --prefix agent test` includes the deterministic golden grader
  against `agent/golden/golden-conversations.json` (committed verbatim; never special-case a
  golden case); `verify` adds a report-only golden live pass over the P0 set. `experience:m6` is the calm guided-UI slice
  (first visit → wizard setup → calm chat home → warm grounded answer → the exact
  "General guidance — not from saved sources" label; the m6 milestone gate runs it);
  `experience:m4` is the chat-first interface slice; `experience:m3` is the proactive slice and
  the final hygiene check.
- Local page: `npm --prefix agent start` → http://127.0.0.1:8787 (the only server; it
  refuses any host other than 127.0.0.1). Headless: `status`, `dry-run`, `tick`,
  `install-scheduler`, `backtest`, `verify`, `extract-expected`, `snapshot`, `profile`.

### Hard boundaries (code-enforced and tested; keep them that way)

- **NY Online Services is never touched.** No login, fill, submit, payment, or
  confirmation retrieval; no portal credentials or portal automation anywhere in code,
  config, or docs. The packet + Web File checklist is the human handoff.
- **Shopify is read-only.** Only `read_*` scopes; no mutation or write operation may be
  added. Missing credentials are shown as "Shopify not connected", never mocked as data.
- **Secrets and PII stay out.** Secrets live only in the gitignored repo-root `.env`;
  `.env.example` stays placeholder-pure. Customer PII and secret values never enter logs,
  transcripts, commits, or fixtures — every log line passes the redaction layer, and
  `data/`, `state/`, `.env` stay gitignored. The PDFs under `data/filed-returns/` are real
  filings: read-only, never copied into commits.
- **Ports.** The agent binds only 127.0.0.1:8787. Ports 5173/4173 belong to the prototype;
  agent work must not start, stop, or reconfigure them.
- **No business-specific constants** in engine, prompts, or tests; profiles carry business
  specifics, and both businesses run the same harness.
- **Numbers and quotes are never model-originated.** Arithmetic and tax rules live in
  deterministic tested TypeScript keyed to the committed `tax-sources/` corpus; the LLM
  classifies, asks, and explains only. Tests use the fake-model harness; live inference
  belongs only to `npm --prefix agent run verify`.

### Conventions

- Server/CLI TypeScript runs on Node's native type stripping (no server build step;
  relative imports use explicit `.ts` extensions). The React page is the only build
  artifact (`agent/dist/web`).
- The client payload types in `agent/src/web/ui/api.ts` are hand-maintained copies of the
  server payload shapes in `agent/src/web/`; any payload change must update both sides.
- State on disk, no database: gitignored `state/<business-slug>/` holds profiles,
  checkpoints, rules, packets, proactive records, and logs.
