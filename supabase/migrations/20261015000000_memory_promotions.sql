-- Business Brain: a member asks for one of their personal memories to become a shared
-- workspace fact, and an owner approves or rejects it. The fact itself lives in Supermemory;
-- this table only carries the request, a snapshot of the text, and the decision.

create table public.memory_promotions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The Supermemory document in the requester's personal namespace.
  personal_doc_id text not null check (personal_doc_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  content text not null check (char_length(content) between 1 and 2000),
  category text not null default 'other'
    check (category in ('customers', 'suppliers', 'products', 'policies', 'voice', 'team', 'other')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- Set once the requester's personal copy of an approved fact has been removed.
  cleaned boolean not null default false,
  created_at timestamptz not null default now()
);
create index memory_promotions_by_workspace on public.memory_promotions (workspace_id, status, created_at);
create unique index memory_promotions_one_pending
  on public.memory_promotions (workspace_id, requested_by, personal_doc_id) where status = 'pending';

alter table public.memory_promotions enable row level security;

create policy "members see their own requests, owners see all" on public.memory_promotions
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (requested_by = (select auth.uid()) or public.is_workspace_owner(workspace_id))
  );
create policy "members request for themselves" on public.memory_promotions
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and requested_by = (select auth.uid())
    and status = 'pending' and decided_by is null and decided_at is null and not cleaned
  );
create policy "owners and requesters update" on public.memory_promotions
  for update to authenticated
  using (public.is_workspace_owner(workspace_id) or requested_by = (select auth.uid()))
  with check (public.is_workspace_owner(workspace_id) or requested_by = (select auth.uid()));

-- Only owners decide. A requester may only mark their own approved request as cleaned up.
create function public.memory_promotions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not public.is_workspace_owner(old.workspace_id)
     and (new.status is distinct from old.status
          or new.decided_by is distinct from old.decided_by
          or new.decided_at is distinct from old.decided_at) then
    raise exception 'Only a workspace owner can decide on a shared memory.' using errcode = '42501';
  end if;
  if new.decided_by is distinct from old.decided_by and new.decided_by is distinct from (select auth.uid()) then
    raise exception 'A decision is recorded under the decider.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger memory_promotions_guard before update on public.memory_promotions
  for each row execute function public.memory_promotions_guard();

revoke all on table public.memory_promotions from anon;
revoke update on table public.memory_promotions from authenticated;
grant update (status, decided_by, decided_at, cleaned) on table public.memory_promotions to authenticated;
