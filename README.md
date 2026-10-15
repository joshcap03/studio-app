# Studio

An AI workspace for running a business. Sign up, tell Studio about your business, connect the
apps you already use, and chat with an assistant that works with your own context, memory,
and accounts.

## What you can do

- **Ask about your business and get it done.** The assistant reads your connected apps
  (Gmail, Google Calendar, Sheets, Drive, Slack, Notion, and more), researches the web, and
  works through multi-step tasks while you watch its progress.
- **Stay in control.** Anything that changes your accounts, like sending an email or editing
  a sheet, pauses and shows you exactly what will happen. Nothing runs until you approve.
- **See the results.** Emails, rows, files, and sources the assistant found collect in a
  Results panel next to the chat.
- **Steer it mid-task.** Send a message while it's working to change direction, and it may
  ask you a quick multiple-choice question when it needs a decision.
- **Let it remember.** Studio keeps the useful facts about your business and how you like
  things done. You'll see what it saves, with Undo, and can manage memory in Settings.
- **Organize with projects.** Group related chats in a project with shared instructions and
  files.
- **Reuse your playbooks.** Save step-by-step instructions as skills and attach one to any
  message by typing "/".
- **Bring your files.** Attach PDFs, Word docs, CSV and text files, and images to a message.

## Private by design

Each business gets its own workspace. Your conversations, files, memory, and connected
accounts are private to you; nobody in another workspace can see or use them. Connected
apps use your own sign-in, and you can disconnect them at any time.

## For developers

Studio is a Next.js app on Supabase. The assistant runs as a separate agent service
(Langflow today) behind a provider-neutral adapter. To run it locally, understand the
architecture, or deploy your own copy, see [docs/development.md](docs/development.md).
