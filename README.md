# Studio

Studio gives you AI agents you shape for any job: running a business, a job search, a
project, or your own errands. Sign up, start an agent from a template, and it interviews you
to learn what you need, then works with your profile, files, memory, and the apps you connect.

## What you can do

- **Have several agents, one you.** One login holds as many agents as you need, say a
  business agent and a job-search agent. Each has its own name, instructions, chats, tasks,
  skills, and files. They all share what you tell Studio about yourself, your personal
  memory, and your connected apps, so you only say it once.
- **Start from a template.** Pick **Job search**, **Small business**, **Sales pipeline**,
  **Inbox & calendar**, **Content & social**, or **Start from scratch**. A template brings
  starting instructions, skills, suggested apps, and sometimes tasks (paused until you turn
  them on). It never overwrites anything you've written.
- **Let it set itself up.** A new agent opens with a setup interview. It asks what you're
  really trying to get done and what success looks like, gathers what it needs (a résumé,
  say), shows a real trial run for you to judge, writes out its plan for the job and asks
  for your advice on it, then proposes its setup. Nothing changes
  until you click Apply, and "Do the first one now" runs its first task right away.
- **Get work done in chat.** The agent reads your connected apps (Gmail, Outlook, Google
  Calendar, Sheets, Docs, and Drive, Slack, Notion, Airtable, HubSpot, Shopify, QuickBooks,
  Stripe, Apollo, Hunter, Clay, and more), searches the web, browses pages in its own browser,
  and works through multi-step jobs while you watch each step.
- **Answer with a tap.** When it needs a decision it asks with something to react to:
  choices, a ranking, a scale, keep-or-pass on results it found, or a short form. Your
  answers go back as your next message.
- **Stay in control.** Anything that changes your accounts, like sending an email or editing
  a sheet, pauses and shows you exactly what will happen. Nothing runs until you approve.
- **See the results.** Emails, rows, files, and sources collect in a Results panel
  next to the chat. Answers cite their sources inline, and only sources the agent actually
  read.
- **Hand off long-running work.** Tasks give the agent a goal, a plan it keeps current, a
  schedule (daily, weekdays, weekly, or every few hours, in your time zone), and a tracker
  of what it has found, like job applications and contacts. Run one now or let it run on
  its schedule; quiet runs stay quiet and you get a nudge when one needs you.
- **Steer it mid-task.** Send a message while it's working to change direction.
- **Let it remember.** Studio keeps useful facts about you and each agent's work. You'll see
  what it saves, with Undo, and can manage memory on the agent's page.
- **Give it your files.** Add files an agent reads in every chat (your résumé, a price list),
  attach PDFs, Word docs, CSVs, text, and images to a message, or group chats in a project
  with shared instructions and files.
- **Reuse your playbooks.** Save step-by-step instructions as skills and attach one to any
  message by typing "/".
- **Rate replies.** Thumbs up or down on any reply, with an optional "why?".
- **Take it with you.** Add Studio to your phone's home screen and get a notification when a
  task finishes or needs your OK.
- **Talk it through (preview).** Start a voice call to walk through setup out loud. The voice
  only relays; the same agent does the thinking, and your words land in the chat. Studio never
  stores audio.

## Private by design

Your conversations, files, tasks, memory, and connected apps are private to you; nobody
else's account can see or use them. Connected apps use your own sign-in, you can disconnect
them at any time, and the agent can't change anything in them without your approval.

## For developers

Studio is a Next.js app on Supabase. The agent runs as a separate service (Langflow today)
behind a provider-neutral adapter, scheduled tasks run in a Trigger.dev background worker,
and voice calls use ElevenLabs.

- [docs/development.md](docs/development.md): run it locally, the architecture, connecting
  Langflow and Composio, and the isolation tests
- [docs/deploy-checklist.md](docs/deploy-checklist.md): deploy your own copy (Vercel,
  Supabase Cloud, Trigger.dev)
- [docs/voice.md](docs/voice.md): voice calls
- [langflow/deploy/README.md](langflow/deploy/README.md): hosting Langflow
- [AGENTS.md](AGENTS.md): code layout and the rules every change follows
