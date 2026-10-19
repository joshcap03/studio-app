-- Who an agent is to one member: a drawing that firms up as they work together (sketch, drawn,
-- ready) and, once the member keeps the name it suggests, arrives with a name and a manner of
-- speaking. Per member, like personal memory, since "it knows you" is about one person. The
-- stage is a presentation hint the app moves forward from the member's own usage; it never
-- gates what the agent can do.
create table public.agent_companions (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  stage text not null default 'sketch' check (stage in ('sketch', 'drawn', 'ready', 'arrived')),
  name text check (name is null or char_length(name) between 1 and 40),
  -- The name the agent suggested, kept to see how often members keep it.
  suggested_name text check (suggested_name is null or char_length(suggested_name) between 1 and 40),
  manner text check (manner is null or char_length(manner) between 1 and 600),
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  check (stage <> 'arrived' or name is not null)
);

alter table public.agent_companions enable row level security;

create policy "own companions" on public.agent_companions
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Created and changed by its member; it goes away only with the agent or the person.
revoke all on table public.agent_companions from anon;
revoke insert, update, delete on table public.agent_companions from authenticated;
grant insert (workspace_id, stage, name, suggested_name, manner, arrived_at, updated_at) on table public.agent_companions to authenticated;
grant update (stage, name, suggested_name, manner, arrived_at, updated_at) on table public.agent_companions to authenticated;
