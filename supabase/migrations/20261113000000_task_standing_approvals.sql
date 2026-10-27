-- Standing approvals: a member's lasting OK, on one task, for one kind of change.
--
-- Some changes in a member's accounts are tidy and undoable and reach no one: putting labels on
-- their own mail, say. A task that does one every morning would otherwise wait on a tap every
-- morning. So when a request qualifies, its card offers "Approve, and don't ask again on this
-- task"; later runs of that task approve requests of the same kind themselves, and the card shows
-- it was their OK that covered it.
--
-- Whether a request qualifies is decided once, when the agent asks, from the actions approving it
-- would run (src/lib/approvals/standing.ts), never from the agent's own words: only a few kinds
-- Studio can check from their arguments, and nothing that sends, deletes, archives, trashes, or
-- moves money. The kind is kept with the request (standing). A decision a task's standing OK made
-- is recorded as decided_via 'standing', and only on a request of a kind that qualifies.
--
-- The OK itself lives on the task (allowed_actions): given only by the member's own tap on a real
-- request in that task's conversation, taken back on the task's page, and gone with the task.
--
-- Additive only: the running code never reads these columns, and every default fails closed.

alter table public.approvals
  add column standing text check (standing in ('gmail_labels'));

alter table public.approvals drop constraint approvals_decided_via_check;
alter table public.approvals
  add constraint approvals_decided_via_check check (decided_via in ('tap', 'voice', 'standing')),
  add constraint approvals_standing_decision check (decided_via is distinct from 'standing' or standing is not null);

grant insert (standing) on table public.approvals to authenticated;

alter table public.agent_tasks
  add column allowed_actions text[] not null default '{}'
    check (allowed_actions <@ array['gmail_labels']::text[]);

grant update (allowed_actions) on table public.agent_tasks to authenticated;
