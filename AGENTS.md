# Repository guide

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
