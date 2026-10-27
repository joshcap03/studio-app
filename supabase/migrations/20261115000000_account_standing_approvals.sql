-- Standing approvals for the person, not just one task.
--
-- A member's lasting OK for one kind of change (src/lib/approvals/standing.ts: today, labels on
-- their own Gmail) was kept on one task (agent_tasks.allowed_actions), so chats with any agent,
-- and every other task, asked again each time. It now lives on the person's account, where their
-- connected apps live too: once they tap "Don't ask again" on a request of that kind, any run of
-- any of their agents approves requests of that kind itself, recorded as decided_via 'standing'.
-- Anything else (sending, deleting, archiving, money, code) still waits for them.
--
-- Given only by the member's own tap on a real request of that kind; taken back in Settings.
-- Task-level OKs from before stay in force and on the task's page.
--
-- Additive only: the running code never reads this column, and the default fails closed.

alter table public.accounts
  add column allowed_actions text[] not null default '{}'
    check (allowed_actions <@ array['gmail_labels']::text[]);

grant update (allowed_actions) on table public.accounts to authenticated;
