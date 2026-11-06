-- What an agent's brief and skills were before each change, so a member building an agent can
-- experiment and go back. Triggers write it, whichever path made the change (the editors, an
-- applied proposal, a template), so nothing can skip it. Readable by the agent's owners only,
-- since only they can change what it records; nobody writes it directly.

create table public.agent_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  author uuid references auth.users (id) on delete set null,
  part text not null check (part in ('profile', 'instructions', 'skill')),
  -- The skill it was, with no foreign key: a deleted skill's revision is how it comes back.
  skill_id uuid,
  -- This revision is a skill as it was when it was deleted.
  deleted boolean not null default false,
  -- { text } for the brief's parts; { name, description, instructions, catalog_id } for a skill.
  previous jsonb not null,
  created_at timestamptz not null default now(),
  check ((part = 'skill') = (skill_id is not null)),
  check (not deleted or part = 'skill')
);
create index agent_revisions_by_part on public.agent_revisions (workspace_id, part, skill_id, created_at desc);

alter table public.agent_revisions enable row level security;

create policy "owners read revisions" on public.agent_revisions
  for select to authenticated using (public.is_workspace_owner(workspace_id));

revoke all on table public.agent_revisions from anon, authenticated;
grant select on table public.agent_revisions to authenticated;

-- Records `previous` for one part. A burst of edits (autosave while typing) is one step: nothing
-- new within ten minutes of the last, by the same person, unless a restore or delete asks for it.
-- Keeps the latest 50 of each part.
create function public.record_agent_revision(ws uuid, which text, skill uuid, was jsonb, gone boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  forced boolean := gone or coalesce(current_setting('studio.revision_force', true), '') = 'on';
begin
  if not forced and exists (
    select 1 from public.agent_revisions r
    where r.workspace_id = ws and r.part = which and r.skill_id is not distinct from skill
      and r.author is not distinct from auth.uid()
      and r.created_at > now() - interval '10 minutes'
  ) then
    return;
  end if;
  insert into public.agent_revisions (workspace_id, author, part, skill_id, deleted, previous)
  values (ws, auth.uid(), which, skill, gone, was);
  delete from public.agent_revisions r
  where r.id in (
    select old_row.id from public.agent_revisions old_row
    where old_row.workspace_id = ws and old_row.part = which and old_row.skill_id is not distinct from skill
    order by old_row.created_at desc
    offset 50
  );
end;
$$;
revoke all on function public.record_agent_revision(uuid, text, uuid, jsonb, boolean) from public, anon, authenticated;

create function public.agent_settings_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Filling in an empty part isn't a change worth going back on.
  if coalesce(old.business_context, '') <> '' and old.business_context is distinct from new.business_context then
    perform public.record_agent_revision(new.workspace_id, 'profile', null, jsonb_build_object('text', old.business_context), false);
  end if;
  if coalesce(old.agent_instructions, '') <> '' and old.agent_instructions is distinct from new.agent_instructions then
    perform public.record_agent_revision(new.workspace_id, 'instructions', null, jsonb_build_object('text', old.agent_instructions), false);
  end if;
  return new;
end;
$$;
revoke all on function public.agent_settings_revision() from public, anon, authenticated;

create trigger agent_settings_revision
  after update of business_context, agent_instructions on public.workspace_settings
  for each row execute function public.agent_settings_revision();

create function public.agent_skill_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Deleted along with its agent: the agent's revisions are going too.
    if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
      perform public.record_agent_revision(
        old.workspace_id, 'skill', old.id,
        jsonb_build_object('name', old.name, 'description', old.description, 'instructions', old.instructions, 'catalog_id', old.catalog_id),
        true
      );
    end if;
    return old;
  end if;
  if (old.name, old.description, old.instructions) is distinct from (new.name, new.description, new.instructions) then
    perform public.record_agent_revision(
      new.workspace_id, 'skill', new.id,
      jsonb_build_object('name', old.name, 'description', old.description, 'instructions', old.instructions, 'catalog_id', old.catalog_id),
      false
    );
  end if;
  return new;
end;
$$;
revoke all on function public.agent_skill_revision() from public, anon, authenticated;

create trigger agent_skill_revision
  after update of name, description, instructions or delete on public.workspace_skills
  for each row execute function public.agent_skill_revision();

-- Puts a part back as a revision had it. Runs as the caller, so their own RLS and grants decide
-- whether they may, and the triggers above record what it replaced, always, so a restore can be
-- undone too. A deleted skill comes back with its id; if its library entry has been added again
-- since, it comes back as the owner's own.
create function public.restore_agent_revision(revision uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r public.agent_revisions;
  entry text;
begin
  select * into r from public.agent_revisions where id = revision;
  if not found then
    raise exception 'revision not found' using errcode = 'P0002';
  end if;
  perform set_config('studio.revision_force', 'on', true);
  if r.part = 'profile' then
    update public.workspace_settings set business_context = r.previous ->> 'text', updated_at = now() where workspace_id = r.workspace_id;
  elsif r.part = 'instructions' then
    update public.workspace_settings set agent_instructions = r.previous ->> 'text', updated_at = now() where workspace_id = r.workspace_id;
  else
    update public.workspace_skills
    set name = r.previous ->> 'name', description = r.previous ->> 'description', instructions = r.previous ->> 'instructions', updated_at = now()
    where id = r.skill_id and workspace_id = r.workspace_id;
    if not found then
      entry := r.previous ->> 'catalog_id';
      if entry is not null and exists (select 1 from public.workspace_skills s where s.workspace_id = r.workspace_id and s.catalog_id = entry) then
        entry := null;
      end if;
      insert into public.workspace_skills (id, workspace_id, catalog_id, name, description, instructions)
      values (r.skill_id, r.workspace_id, entry, r.previous ->> 'name', r.previous ->> 'description', r.previous ->> 'instructions');
    end if;
  end if;
  perform set_config('studio.revision_force', '', true);
end;
$$;
revoke all on function public.restore_agent_revision(uuid) from public, anon;
grant execute on function public.restore_agent_revision(uuid) to authenticated;
