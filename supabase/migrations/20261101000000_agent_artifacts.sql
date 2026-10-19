-- The Library: what a member's agent made for them (a Google Sheet, a doc) and links they filed
-- themselves, kept in one place after the chat that made them scrolls away. Private to the
-- member, like tasks and the tracker. One row per link: the agent producing the same doc again
-- updates its row rather than adding another.

create table public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Keep in sync with ARTIFACT_KINDS in src/lib/types.ts.
  kind text not null check (kind in ('spreadsheet', 'document', 'presentation', 'pdf', 'image', 'data', 'file', 'link')),
  title text not null check (char_length(title) between 1 and 300),
  url text not null check (char_length(url) <= 4000 and url ~* '^https://'),
  description text check (description is null or char_length(description) <= 500),
  source text check (source is null or char_length(source) <= 100),
  -- Who filed it: the agent (from a tool's own result) or the member.
  added_by text not null check (added_by in ('agent', 'member')),
  pinned boolean not null default false,
  conversation_id uuid,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, url),
  foreign key (conversation_id, workspace_id, user_id)
    references public.conversations (id, workspace_id, user_id) on delete set null (conversation_id),
  foreign key (source_message_id, workspace_id, user_id)
    references public.messages (id, workspace_id, user_id) on delete set null (source_message_id)
);
create index agent_artifacts_recent on public.agent_artifacts (workspace_id, user_id, updated_at desc);

-- Keep in sync with MAX_LIBRARY_ITEMS in src/lib/types.ts. Serialized per member and agent so
-- concurrent adds can't overshoot; the count runs under the caller's RLS, which is their rows.
create function public.agent_artifacts_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('agent_artifacts:' || new.workspace_id::text || ':' || new.user_id::text, 0));
  if (select count(*) from public.agent_artifacts a where a.workspace_id = new.workspace_id and a.user_id = new.user_id) >= 500 then
    raise exception 'library limit reached' using errcode = 'P0001', hint = 'artifact_limit';
  end if;
  return new;
end;
$$;
create trigger agent_artifacts_cap before insert on public.agent_artifacts
  for each row execute function public.agent_artifacts_cap();

alter table public.agent_artifacts enable row level security;

create policy "own artifacts" on public.agent_artifacts
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Ids, tenancy, links, and who filed it are fixed; the member can rename and pin, and a later
-- run that makes the same doc again moves it up and points it at that run.
revoke all on table public.agent_artifacts from anon;
revoke update on table public.agent_artifacts from authenticated;
grant update (title, pinned, conversation_id, source_message_id, updated_at) on table public.agent_artifacts to authenticated;

revoke execute on function public.agent_artifacts_cap() from public, anon, authenticated;
