# Studio

A mobile-first web app for a jewelry studio: capture vendor receipts, sort costs into
items, track designs and pieces, and record sales with profit.

## Status

Prototype. The whole UI runs in the browser with seed data held in React state. There is
no backend, no database, and no persistence, so data resets on every reload. Sign-in is a
placeholder that accepts any input.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

## Commands

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm run dev`        | Start the Vite dev server with hot reload              |
| `npm run build`      | Type check (`tsc -b`) then build to `dist/`            |
| `npm run preview`    | Serve the built app from `dist/`                       |
| `npm run typecheck`  | Type check only                                        |
| `npm test`           | Run the vitest suite once (jsdom)                      |
| `npm run test:watch` | Run vitest in watch mode                               |
| `npm run qa:serve`   | Dev server pinned to 127.0.0.1:5173, for scripted QA   |
| `npm run qa:preview` | Preview server pinned to 127.0.0.1:4173 (build first)  |

## Screens

`signin` → `home` → `receipt` (photo or manual) → `items` / `new-item` →
`pieces` / `new-piece` / `piece` / `sold` → `account`. Loading the app at `/states`
opens a review screen that jumps straight to any of these states.

## For agents

See `AGENTS.md` for commands, layout, conventions, and the verification checklist.
