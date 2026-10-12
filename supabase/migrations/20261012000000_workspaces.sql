-- Multi-tenant foundation: workspaces are the tenant boundary.
--
-- Isolation is enforced in the database, not only in the app: every table has Row Level
-- Security, every policy keys on the authenticated user (auth.uid()) and workspace
-- membership, and composite foreign keys make it impossible to attach a row to another
-- tenant's conversation by mislabeling ids. The app talks to Postgres with the signed-in
-- user's JWT, so these policies apply to every request it makes.
--
-- Visibility model (MVP):
--   workspace, settings, shared memory   -> every member of the workspace
--   conversations, messages, usage rows  -> only the member who created them
--   membership row (incl. composio id)   -> only that member
--   personal memory                      -> only that member

------------------------------------------------------------------------------------------
-- Tables

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  -- Stable, opaque id for this member's tool connections (Composio "user id"). One per
  -- membership, so a person's connections in one workspace never appear in another.
  composio_user_id text not null unique default ('lj_' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_by_user on public.workspace_members (user_id);

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  business_context text not null default '' check (char_length(business_context) <= 8000),
  agent_instructions text not null default '' check (char_length(agent_instructions) <= 8000),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  agent_provider text,
  agent_thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id, user_id)
);
create index conversations_by_owner on public.conversations (workspace_id, user_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  conversation_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null default '' check (char_length(content) <= 200000),
  status text not null check (status in ('streaming', 'complete', 'stopped', 'error', 'interrupted')),
  activity jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  error text check (char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A message can only belong to a conversation in the same workspace, owned by the same user.
  foreign key (conversation_id, workspace_id, user_id)
    references public.conversations (id, workspace_id, user_id) on delete cascade
);
create index messages_by_conversation on public.messages (conversation_id, seq);
create index messages_streaming_by_user on public.messages (user_id) where status = 'streaming';

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- null: shared business memory for the workspace; set: private to that member.
  user_id uuid references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index memories_by_workspace on public.memories (workspace_id, created_at desc);

create table public.usage_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('agent_run')),
  created_at timestamptz not null default now()
);
create index usage_by_workspace on public.usage_events (workspace_id, created_at);
create index usage_by_user on public.usage_events (user_id, created_at);

------------------------------------------------------------------------------------------
-- Membership helpers (security definer so policies can consult membership without
-- recursing through workspace_members' own policy).

create function public.is_workspace_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create function public.is_workspace_owner(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

------------------------------------------------------------------------------------------
-- Row Level Security

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.usage_events enable row level security;

-- workspaces: members read; owners rename or delete. Creation goes through create_workspace().
create policy "members read workspace" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy "owners update workspace" on public.workspaces
  for update to authenticated using (public.is_workspace_owner(id)) with check (public.is_workspace_owner(id));
create policy "owners delete workspace" on public.workspaces
  for delete to authenticated using (public.is_workspace_owner(id));

-- memberships: each user sees only their own rows. No direct writes.
create policy "read own memberships" on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()));

-- settings: members read; owners edit.
create policy "members read settings" on public.workspace_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "owners update settings" on public.workspace_settings
  for update to authenticated using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- conversations and messages: the owning member, inside a workspace they belong to.
create policy "own conversations" on public.conversations
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

create policy "own messages" on public.messages
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- memories: shared rows visible to members; personal rows only to their owner.
create policy "read memories" on public.memories
  for select to authenticated
  using (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));
create policy "add memories" on public.memories
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = (select auth.uid())
    and (user_id is null or user_id = (select auth.uid()))
  );
create policy "remove memories" on public.memories
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (user_id = (select auth.uid())
         or (user_id is null and (created_by = (select auth.uid()) or public.is_workspace_owner(workspace_id))))
  );

-- usage: append-only by the acting member; never updated or deleted by users.
create policy "read own usage" on public.usage_events
  for select to authenticated using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "record own usage" on public.usage_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Column-level write limits: ids, ownership, and tenancy columns are immutable.
revoke all on table public.workspaces, public.workspace_members, public.workspace_settings,
  public.conversations, public.messages, public.memories, public.usage_events from anon;
revoke insert, update on table public.workspaces, public.workspace_members, public.workspace_settings from authenticated;
grant update (name) on table public.workspaces to authenticated;
grant update (business_context, agent_instructions, updated_at) on table public.workspace_settings to authenticated;
revoke update on table public.conversations, public.messages, public.memories, public.usage_events from authenticated;
grant update (title, agent_provider, agent_thread_id, updated_at) on table public.conversations to authenticated;
grant update (content, status, activity, artifacts, error, updated_at) on table public.messages to authenticated;

------------------------------------------------------------------------------------------
-- RPCs

-- Create a workspace owned by the caller, with its membership and settings, atomically.
create function public.create_workspace(p_name text, p_business_context text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ws uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.workspaces w where w.created_by = uid) >= 3 then
    raise exception 'workspace limit reached' using errcode = 'P0001', hint = 'workspace_limit';
  end if;
  insert into public.workspaces (name, created_by) values (trim(p_name), uid) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into public.workspace_settings (workspace_id, business_context)
    values (ws, coalesce(p_business_context, ''));
  return ws;
end;
$$;

-- Usage counters for limit checks. Only answers for a workspace the caller belongs to.
create function public.usage_snapshot(ws uuid)
returns table (user_last_minute bigint, workspace_today bigint, user_running bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  return query select
    (select count(*) from public.usage_events u
       where u.user_id = auth.uid() and u.created_at > now() - interval '1 minute'),
    (select count(*) from public.usage_events u
       where u.workspace_id = ws and u.created_at > date_trunc('day', now())),
    (select count(*) from public.messages m
       where m.user_id = auth.uid() and m.status = 'streaming' and m.updated_at > now() - interval '5 minutes');
end;
$$;

revoke execute on function public.create_workspace(text, text), public.usage_snapshot(uuid),
  public.is_workspace_member(uuid), public.is_workspace_owner(uuid) from public, anon;
grant execute on function public.create_workspace(text, text), public.usage_snapshot(uuid),
  public.is_workspace_member(uuid), public.is_workspace_owner(uuid) to authenticated;
