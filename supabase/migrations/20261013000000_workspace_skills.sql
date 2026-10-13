-- Skills: named instructions for a task, added to a workspace from the built-in library or
-- written by the owner. A skill reaches the agent only on a message it is attached to, so it
-- costs nothing until it's used. Every member can read and use them; only owners change them.

create table public.workspace_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The library entry it was copied from; null for the owner's own.
  catalog_id text check (char_length(catalog_id) between 1 and 80),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 200),
  instructions text not null check (char_length(instructions) between 1 and 4000),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, catalog_id)
);
create index workspace_skills_by_workspace on public.workspace_skills (workspace_id, created_at);

alter table public.workspace_skills enable row level security;

create policy "members read skills" on public.workspace_skills
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "owners add skills" on public.workspace_skills
  for insert to authenticated
  with check (public.is_workspace_owner(workspace_id) and created_by = (select auth.uid()));
create policy "owners update skills" on public.workspace_skills
  for update to authenticated
  using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy "owners remove skills" on public.workspace_skills
  for delete to authenticated using (public.is_workspace_owner(workspace_id));

-- Ids, tenancy, and origin are immutable once added.
revoke all on table public.workspace_skills from anon;
revoke update on table public.workspace_skills from authenticated;
grant update (name, description, instructions, updated_at) on table public.workspace_skills to authenticated;

-- Which skill a user message was sent with ({ id, name }), for display and retry. A label
-- only: the instructions are always loaded from the workspace's own skill by the server.
alter table public.messages
  add column skill jsonb check (skill is null or (jsonb_typeof(skill) = 'object' and pg_column_size(skill) <= 512));
