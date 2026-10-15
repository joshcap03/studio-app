-- Projects: a member's folders of related conversations, with instructions and files the
-- agent gets on every run in them. Like conversations, a project is private to the member who
-- made it. Composite foreign keys keep a conversation or file from being attached to a
-- project in another workspace or owned by someone else. Deleting a project deletes its
-- conversations and files (the app removes the stored bytes first).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id, user_id)
);
create index projects_by_owner on public.projects (workspace_id, user_id, updated_at desc);

alter table public.conversations add column project_id uuid;
alter table public.conversations
  add foreign key (project_id, workspace_id, user_id)
  references public.projects (id, workspace_id, user_id) on delete cascade;
create index conversations_by_project on public.conversations (project_id, updated_at desc) where project_id is not null;

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 200),
  mime_type text not null check (char_length(mime_type) between 1 and 100),
  size integer not null check (size > 0 and size <= 10485760),
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  -- Bytes live in the attachments bucket under <workspace>/<user>/, like message attachments.
  check (storage_path like workspace_id::text || '/' || user_id::text || '/%'),
  foreign key (project_id, workspace_id, user_id)
    references public.projects (id, workspace_id, user_id) on delete cascade
);
create index project_files_by_project on public.project_files (project_id, created_at);

alter table public.projects enable row level security;
alter table public.project_files enable row level security;

create policy "own projects" on public.projects
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

create policy "own project files" on public.project_files
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.projects, public.project_files from anon;
revoke update on table public.projects, public.project_files from authenticated;
grant update (name, instructions, updated_at) on table public.projects to authenticated;
grant update (project_id) on table public.conversations to authenticated;
