-- Long-horizon agent tasks: a goal the agent keeps working on, with a plan it updates, an
-- optional schedule, and a conversation where its runs report. Each run is recorded once per
-- scheduled time, and the agent can keep a tracker of things it finds (records, e.g. job
-- applications keyed by job URL).
--
-- All three tables are private to the member who owns them, like conversations: a task runs
-- as that member, under these same policies. Composite foreign keys keep a task, run, or
-- record from pointing at another workspace's skill or another member's conversation, task,
-- or message. Tenancy columns are immutable.

------------------------------------------------------------------------------------------
-- Keys the composite foreign keys below rely on

alter table public.workspace_skills add constraint workspace_skills_tenant_key unique (id, workspace_id);

------------------------------------------------------------------------------------------
-- Plan validation: an array of at most 30 steps, each { id, text, status, note? }.

create function public.is_valid_task_plan(plan jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(plan) = 'array'
    and jsonb_array_length(plan) <= 30
    and pg_column_size(plan) <= 16384
    and not exists (
      select 1 from jsonb_array_elements(plan) as step
      where jsonb_typeof(step) <> 'object'
        or jsonb_typeof(step -> 'id') is distinct from 'string'
        or jsonb_typeof(step -> 'text') is distinct from 'string'
        or (step ->> 'status') is null
        or (step ->> 'status') not in ('todo', 'doing', 'done', 'blocked', 'needs_you')
        or (step ? 'note' and jsonb_typeof(step -> 'note') not in ('string', 'null'))
    );
$$;

------------------------------------------------------------------------------------------
-- Tables

create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  instructions text not null default '' check (char_length(instructions) <= 4000),
  skill_id uuid,
  -- { every, at?, weekday?, hours? } (src/lib/tasks/schedule.ts); null runs only on demand.
  schedule jsonb check (schedule is null or (jsonb_typeof(schedule) = 'object' and pg_column_size(schedule) <= 512)),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'archived')),
  plan jsonb not null default '[]'::jsonb check (public.is_valid_task_plan(plan)),
  conversation_id uuid,
  next_run_at timestamptz,
  last_run_at timestamptz,
  -- The template task it was created from, so applying a template twice doesn't duplicate it.
  template_task_id text check (template_task_id is null or char_length(template_task_id) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id, user_id),
  unique (workspace_id, user_id, template_task_id),
  foreign key (skill_id, workspace_id)
    references public.workspace_skills (id, workspace_id) on delete set null (skill_id),
  foreign key (conversation_id, workspace_id, user_id)
    references public.conversations (id, workspace_id, user_id) on delete set null (conversation_id)
);
create index agent_tasks_by_owner on public.agent_tasks (workspace_id, user_id, updated_at desc);
create index agent_tasks_due on public.agent_tasks (next_run_at) where status = 'active';

create table public.agent_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
  reason text check (char_length(reason) <= 500),
  message_id uuid,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One run per task per scheduled time, so a retried scheduler can't run it twice.
  unique (task_id, scheduled_for),
  foreign key (task_id, workspace_id, user_id)
    references public.agent_tasks (id, workspace_id, user_id) on delete cascade,
  foreign key (message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete set null (message_id)
);
create index agent_task_runs_by_task on public.agent_task_runs (task_id, scheduled_for desc);

create table public.agent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection text not null check (collection ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  key text not null check (char_length(key) between 1 and 200),
  title text not null default '' check (char_length(title) <= 200),
  status text check (status is null or char_length(status) between 1 and 40),
  url text check (url is null or (char_length(url) <= 2000 and url ~* '^https?://')),
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) <= 8192),
  task_id uuid,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, collection, key),
  foreign key (task_id, workspace_id, user_id)
    references public.agent_tasks (id, workspace_id, user_id) on delete set null (task_id),
  foreign key (source_message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete set null (source_message_id)
);
create index agent_records_recent on public.agent_records (workspace_id, user_id, collection, updated_at desc);

-- At most 500 records per member per collection. Serialized per collection so concurrent
-- inserts can't overshoot; the count runs under the caller's RLS, which is exactly their rows.
create function public.agent_records_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text || ':' || new.user_id::text || ':' || new.collection, 0));
  if (select count(*) from public.agent_records r
      where r.workspace_id = new.workspace_id and r.user_id = new.user_id and r.collection = new.collection) >= 500 then
    raise exception 'record limit reached' using errcode = 'P0001', hint = 'record_limit';
  end if;
  return new;
end;
$$;
create trigger agent_records_cap before insert on public.agent_records
  for each row execute function public.agent_records_cap();

-- Where a message came from when no one typed it, e.g. { kind: "task", taskId, runId }.
-- Covered by the existing messages policies; set on insert, never changed.
alter table public.messages
  add column origin jsonb check (origin is null or (jsonb_typeof(origin) = 'object' and pg_column_size(origin) <= 512));

------------------------------------------------------------------------------------------
-- Row Level Security: the owning member, inside a workspace they belong to.

alter table public.agent_tasks enable row level security;
alter table public.agent_task_runs enable row level security;
alter table public.agent_records enable row level security;

create policy "own tasks" on public.agent_tasks
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

create policy "own task runs" on public.agent_task_runs
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

create policy "own records" on public.agent_records
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Ids, tenancy, and origins are immutable.
revoke all on table public.agent_tasks, public.agent_task_runs, public.agent_records from anon;
revoke update on table public.agent_tasks, public.agent_task_runs, public.agent_records from authenticated;
grant update (title, instructions, skill_id, schedule, timezone, status, plan, conversation_id,
  next_run_at, last_run_at, updated_at) on table public.agent_tasks to authenticated;
grant update (status, reason, message_id, cancel_requested_at, updated_at) on table public.agent_task_runs to authenticated;
grant update (title, status, url, fields, task_id, source_message_id, updated_at) on table public.agent_records to authenticated;

revoke execute on function public.agent_records_cap() from public, anon, authenticated;
