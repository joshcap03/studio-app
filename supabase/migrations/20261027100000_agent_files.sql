-- Agent files: a member's own shelf of files (a résumé, a price list) that one agent gets on
-- every run, in every conversation. Like project files, a shelf is private to the member who
-- filled it, and its bytes live in their folder of the attachments bucket. Rows never change
-- once added (remove and re-add instead), so a file can't be moved to another agent or owner.

create table public.agent_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  mime_type text not null check (char_length(mime_type) between 1 and 100),
  size integer not null check (size > 0 and size <= 10485760),
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  -- Bytes live in the attachments bucket under <workspace>/<user>/, like message attachments.
  check (storage_path like workspace_id::text || '/' || user_id::text || '/%')
);
create index agent_files_by_owner on public.agent_files (workspace_id, user_id, created_at);

alter table public.agent_files enable row level security;

create policy "own agent files" on public.agent_files
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.agent_files from anon;
revoke update on table public.agent_files from authenticated;

-- Keep in sync with MAX_AGENT_FILES in src/lib/types.ts. Checked here too, so the cap holds
-- for members reaching the table directly and for concurrent adds.
create function public.agent_files_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('agent_files:' || new.workspace_id::text || ':' || new.user_id::text, 0));
  if (select count(*) from public.agent_files f where f.workspace_id = new.workspace_id and f.user_id = new.user_id) >= 10 then
    raise exception 'agent files limit reached' using errcode = 'P0001', hint = 'agent_files_cap';
  end if;
  return new;
end;
$$;

create trigger agent_files_cap before insert on public.agent_files
  for each row execute function public.agent_files_cap();

-- Moves one of the caller's unsent message attachments in this workspace onto their shelf, in one
-- step: the attachment row goes, an agent file with the same id and stored bytes takes its
-- place. Runs as the caller, so RLS decides what they can claim. Returns the new row's id, or
-- null when there's no such unsent attachment of theirs.
create function public.claim_agent_file(p_attachment uuid, p_workspace uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  a public.attachments;
begin
  delete from public.attachments
  where id = p_attachment and workspace_id = p_workspace and user_id = (select auth.uid()) and message_id is null
  returning * into a;
  if a.id is null then
    return null;
  end if;
  insert into public.agent_files (id, workspace_id, user_id, name, mime_type, size, storage_path)
  values (a.id, a.workspace_id, a.user_id, a.name, a.mime_type, a.size, a.storage_path);
  return a.id;
end;
$$;

revoke execute on function public.claim_agent_file(uuid, uuid) from public, anon;
grant execute on function public.claim_agent_file(uuid, uuid) to authenticated;
