-- Approvals, file attachments, and agent-proposed memories.
--
--   approvals    an action the agent paused on until its member approves or declines it
--   attachments  files a member attached to their own messages (bytes in Storage)
--   messages     gain an 'awaiting' status (paused on an approval) and memory proposals
--
-- Same visibility model as conversations and messages: only the member who owns the
-- conversation sees or changes these rows, and composite foreign keys pin each row to its
-- conversation's workspace and owner.

------------------------------------------------------------------------------------------
-- Messages

alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('streaming', 'complete', 'stopped', 'error', 'interrupted', 'awaiting'));

-- [{ id, content, scope: 'workspace' | 'personal', status: 'pending' | 'saved' | 'dismissed' }]
alter table public.messages add column memory_proposals jsonb not null default '[]'::jsonb;
grant update (memory_proposals) on table public.messages to authenticated;

-- Lets rows reference a message together with its tenant columns.
alter table public.messages add constraint messages_tenant_key unique (id, workspace_id, user_id);

------------------------------------------------------------------------------------------
-- Approvals

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  conversation_id uuid not null,
  message_id uuid not null,
  summary text not null check (char_length(summary) between 1 and 500),
  app text check (char_length(app) <= 40),
  -- [[label, value], …] shown under the summary; sanitized and size-capped by the app.
  details jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  -- What the provider needs to continue the run (e.g. a job id). Never sent to the browser.
  provider text not null check (char_length(provider) <= 40),
  provider_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  foreign key (conversation_id, workspace_id, user_id)
    references public.conversations (id, workspace_id, user_id) on delete cascade,
  foreign key (message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete cascade
);
create index approvals_by_message on public.approvals (message_id);
-- A conversation waits on at most one decision at a time.
create unique index approvals_one_pending on public.approvals (conversation_id) where status = 'pending';

alter table public.approvals enable row level security;
create policy "own approvals" on public.approvals
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.approvals from anon;
revoke update on table public.approvals from authenticated;
grant update (status, decided_at) on table public.approvals to authenticated;

------------------------------------------------------------------------------------------
-- Attachments

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Null until the message it was attached to is sent.
  message_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  mime_type text not null check (char_length(mime_type) between 1 and 100),
  size integer not null check (size > 0 and size <= 10485760),
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  -- Objects live under <workspace>/<user>/ so Storage policies can check them too.
  check (storage_path like workspace_id::text || '/' || user_id::text || '/%'),
  foreign key (message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete cascade
);
create index attachments_by_message on public.attachments (message_id);
create index attachments_by_owner on public.attachments (user_id, created_at);

alter table public.attachments enable row level security;
create policy "own attachments" on public.attachments
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.attachments from anon;
revoke update on table public.attachments from authenticated;
grant update (message_id) on table public.attachments to authenticated;

-- Private bucket. Object names are <workspace id>/<user id>/<random>/<file name>; a member
-- can only reach objects in their own folder of a workspace they belong to.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 10485760)
on conflict (id) do nothing;

create policy "attachments: read own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.foldername(name))[1] in (
      select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
create policy "attachments: add own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.foldername(name))[1] in (
      select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
create policy "attachments: remove own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );
