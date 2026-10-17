-- A member's keep/pass calls on results the agent showed them (a verdict field in one of its
-- forms): a trial run during setup, or a task run's results. They're the member's own bar in
-- practice, so the app shows how much they kept ("4 of 5 kept this week") and the agent sees
-- the ratio and the reasons for passing. One row per judged item; a form is sent once, so rows
-- never change. Private to the member who judged, inside a workspace they belong to.
create table public.agent_verdicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The reply whose card was judged, the card, and the item in it.
  message_id uuid not null,
  block_id uuid not null,
  item_id text not null check (item_id ~ '^[a-z0-9_]{1,48}$'),
  title text not null check (char_length(title) between 1 and 200),
  verdict text not null check (verdict in ('keep', 'pass')),
  reason text check (reason is null or char_length(reason) between 1 and 200),
  -- The task whose conversation it was judged in, if any, for a per-task score.
  task_id uuid,
  created_at timestamptz not null default now(),
  unique (message_id, block_id, item_id),
  foreign key (message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete cascade,
  foreign key (task_id, workspace_id, user_id)
    references public.agent_tasks (id, workspace_id, user_id) on delete set null (task_id)
);
create index agent_verdicts_recent on public.agent_verdicts (workspace_id, user_id, created_at desc);

alter table public.agent_verdicts enable row level security;

create policy "own verdicts" on public.agent_verdicts
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- A verdict is what the member said at the time: added or deleted, never rewritten.
revoke all on table public.agent_verdicts from anon;
revoke update on table public.agent_verdicts from authenticated;
