# Studio

This repository holds two things:

- **NY Sales Tax Agent** (`agent/`) — a deterministic quarterly ST-100 filing
  agent for eligible one-person New York Shopify businesses: it tracks the
  deadline, ingests sales, computes every figure the return asks for,
  reconciles computed vs collected tax, produces a filing packet in Web File
  order, answers grounded NY sales tax questions, and starts on its own days
  before the due date. Operator docs below; package internals in
  [`agent/README.md`](agent/README.md).
- **Jewelry studio prototype** (root `src/`) — the mobile-first React app for
  tracking studio money. It is front-end-only seed data and is unaffected by
  the agent. See [the prototype section](#jewelry-studio-prototype) and
  `AGENTS.md`.

## NY Sales Tax Agent

The agent owns a quarterly filing end to end except the filing itself: New
York Online Services is never logged into, filled, or submitted by this code.
You file from the packet yourself, then record the confirmation.

Eligibility (all four must hold): registered for NY sales tax and filing only
in NY; quarterly ST-100 with no extra schedules; one Shopify store, no
marketplaces; ordinary taxable goods only.

### Setup

Requires Node.js ≥ 22.18.0 and npm 10.

```bash
npm --prefix agent install
cp .env.example .env    # then fill in the keys you have (see Credentials)
```

`.env` is gitignored and holds secrets only; `.env.example` stays
placeholder-pure (a test enforces this).

### Opening the agent (no terminal needed)

Install the double-click launcher once:

```bash
npm --prefix agent run install-app   # writes two apps into ~/Applications
```

After that, double-click **NY Sales Tax Agent.app**. It builds the page if
needed, starts the server in the background on 127.0.0.1:8787 (loopback only;
no terminal window), and opens the page in your browser. If the agent is
already running, a second launch just opens the page. To quit, double-click
**Stop NY Sales Tax Agent.app**; it stops only the server the launcher
started. Launcher and server output go to `state/logs/launcher.log`.

The terminal alternative is the same server in the foreground:

```bash
npm --prefix agent start    # builds the page, serves http://127.0.0.1:8787; Ctrl-C stops it
```

### The chat-first page

The page opens on the chat, even on the very first visit with no business set
up. A "Start here" explainer above the chat says what the agent does, that you
file on NY Online Services yourself, and how to begin, with a **Set up your
business** button. The composer is docked at the bottom of the scrolling
message list: **Enter sends, Shift+Enter starts a new line**.

- **Before setup** you can already ask plain New York sales-tax questions in
  the chat. Answers are written conversationally over the saved official
  sources — the rule, the exact quoted passages with links, and the
  recommendation stay attached to the answer. A question the saved sources do
  not settle gets a general answer clearly labeled "General guidance — not
  from saved sources", plus a question for your CPA. A filing request
  ("Prepare the quarterly ST-100.") tells you plainly that no business is set
  up yet and points to setup; nothing is started.
- **Setup** is a six-step wizard — Basics, Ship-from address, Pickup /
  in-person locations, Eligibility, Notifications and source, Review — with a
  progress line and per-step validation (native browser address autofill
  works; New York is the default state). The Eligibility step asks the five
  eligibility questions. Saving from the Review step writes the profile under
  `state/<business-slug>/` and returns to the chat.
- **After setup** the chat home stays calm: the chat dominates, one
  **Prepare the quarterly ST-100** button is the primary action, and the run
  bar, saved rules, confirmation, and run events stay collapsed behind their
  headers until the state makes them relevant. Send that one message (or type
  your own). The run advances through ingest → compute → reconcile → packet on its
own, pausing at most once per five questions, each with a recommended answer
and evidence. When the run ties out, the draft return and packet are on the
page and on disk.

If you do nothing, the agent comes to you instead: the installed scheduler
ticks daily, starts the same run headlessly inside your profile's start-days
window, emails a one-way ready notice, and follows up at 7/3/1 days before the
due date until the filing is confirmed.

```bash
npm --prefix agent run install-scheduler   # idempotent launchd job, daily 09:00 ET
npm --prefix agent run tick                # run today's tick by hand
npm --prefix agent run status              # per-business deadline and readiness
npm --prefix agent run dry-run             # current-period run from what is connected
```

### From packet to Web File (the human handoff)

The packet is one Markdown file per period at
`state/<business-slug>/packets/<period>.md`, laid out in official ST-100 line
order with every number traceable to order IDs, plus a "what you type where"
checklist. You sign in to NY Web File yourself, key the packet values, pay,
and come back to the page to record the confirmation number and amount paid.
The packet writer refuses to emit a packet with an unexplained reconciliation
gap, and nothing in this repository can log in to, fill, submit, pay through,
or retrieve anything from NY Online Services.

### Tests, backtest, and gates

```bash
npm --prefix agent run typecheck
npm --prefix agent run lint
npm --prefix agent test              # vitest suite incl. hygiene guards
npm --prefix agent run backtest      # engine vs the three filed returns, to the cent
npm --prefix agent run verify        # live Fireworks tool-calling smoke check
```

One-command experience scripts (each is a headless, self-checking run that
leaves nothing running):

| Command | What it proves |
| --- | --- |
| `npm --prefix agent run experience:m1` | Fixture ingest → compute → reconcile → packet for both businesses, cent-exact backtest, expected-figures sign-off |
| `npm --prefix agent run experience:m2` | Cold-start filing in ≤5 questions, saved rules prevent repeats, ten grounded Q&A answers with byte-matched citations |
| `npm --prefix agent run experience:m3` | The proactive slice and final hygiene check: deadline status, honest no-source dry runs, the idempotent 7/3/1 tick ladder, one-way notifications with honest SMTP failure handling, server-start safety tick, idempotent launchd install, and the no-page/no-portal evidence stage |
| `npm --prefix agent run experience:m4` | The chat-first interface: first visit with no business shows the explainer, a grounded pre-setup answer, an honest setup pointer for a filing request, setup, the filing started from the chat, the question batch, a tied-out draft and packet, and a recorded confirmation (transcript in `state/m4-experience/transcript.txt`) |
| `npm --prefix agent run experience:m6` | The calm guided UI: a fresh first visit through the explainer and the six-step setup wizard to the calm post-setup chat home, then a warm grounded answer and an out-of-corpus answer carrying the exact "General guidance — not from saved sources" label (fake model, scripted turns; transcript in `state/m6-experience/transcript.txt`) |
| `npm --prefix agent run experience:m7` | The conversational router: a first-visit "hello" gets a conversation and no run, before and after setup; an explicit "do my sales tax" the day after a quarter closes starts the run on that quarter and pauses on one batched ask; run mechanics stay out of the chat and in the collapsed Activity disclosure (fake model; transcript in `state/m7-experience/transcript.txt`) |

The assistant is graded against Josh's golden behavior spec,
`agent/golden/golden-conversations.json` (committed verbatim, sha256 pinned).
`npm --prefix agent test` runs the deterministic golden grader over every
case and variant; `npm --prefix agent run verify` adds a report-only live pass
over the P0 cases. Unmet cases are reported as known gaps (see `PROGRESS.md`);
prose voice is Josh's own evaluation, with no LLM judge.

The backtest harness runs the engine on period-matched fixtures against the
figures extracted from the three real filed returns (the answer key), plus a
second synthetic business with a different ship-from county to prove nothing
is hardcoded. `npm --prefix agent run extract-expected` re-extracts those
figures from the PDFs under `data/filed-returns/`.

### Credentials and deferred integrations

- **Fireworks (LLM)** — configured in `.env`; the pinned tool-calling model is
  selected by `FIREWORKS_MODEL`. `npm --prefix agent run verify` does a live
  tool-calling round trip without printing the key.
- **SMTP notifications** — deferred until a Gmail app password is supplied.
  Set `SMTP_USER`, `SMTP_PASS`, and `NOTIFY_TO` in `.env`, then run
  `npm --prefix agent run tick` on a due stage to send the real one-way
  message. Until then every notification is honestly recorded as
  `smtp-not-configured` with the ready marker and macOS notification fallback.
- **Shopify live pull** — deferred until the Dev Dashboard app exists. The
  read-only puller ships and is fixture-tested; set `SHOPIFY_SHOP` plus a
  token (`SHOPIFY_ACCESS_TOKEN`, or `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`)
  and run `npm --prefix agent run snapshot -- --period <YYYY-MM-DD>`. With no
  source connected the agent reports sales as unknown, never zero.
- **NY Web File login/fill** — permanently human. Post-filing, only the
  confirmation number and amount paid are recorded, on the page.

### Boundaries (enforced in code and tests)

- Shopify access is read-only: only `read_*` scopes exist, the GraphQL
  documents define no mutation, and a test scans the source for write
  operations.
- Nothing logs in to or automates NY Online Services; portal requests get a
  deterministic refusal, and the configuration surface has no portal
  credential keys (hygiene test).
- Customer PII and secrets never enter logs, transcripts, commits, or
  fixtures; every log line passes a redaction layer and `data/`, `state/`, and
  `.env` are gitignored (hygiene test).
- The server binds only `127.0.0.1` (any other `HOST` is rejected) on port
  8787. Ports 5173/4173 belong to the prototype and are never touched.
- No business-specific constants in engine, prompts, or tests; both businesses
  run the same harness.

More: [`DECISIONS.md`](DECISIONS.md) (locked decisions),
[`WALKTHROUGH.md`](WALKTHROUGH.md) (per-milestone guide),
[`PROGRESS.md`](PROGRESS.md) (status and deferred validation),
[`agent/README.md`](agent/README.md) (package internals),
[`tax-sources/README.md`](tax-sources/README.md) (the official source corpus).

## Jewelry studio prototype

A mobile-first web app for a jewelry studio: capture vendor receipts, sort
costs into items, track designs and pieces, and record sales with profit.

### Status

Prototype. The whole UI runs in the browser with seed data held in React
state. There is no backend, no database, and no persistence, so data resets on
every reload. Sign-in is a placeholder that accepts any input.

### Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

### Commands

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

### Screens

`signin` → `home` → `receipt` (photo or manual) → `items` / `new-item` →
`pieces` / `new-piece` / `piece` / `sold` → `account`. Loading the app at
`/states` opens a review screen that jumps straight to any of these states.

## For agents

See `AGENTS.md` for commands, layout, conventions, boundaries, and the
verification checklist for both projects.
