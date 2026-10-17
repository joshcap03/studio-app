-- Accounts: what belongs to the person rather than to one of their agents (workspaces).
--
-- One login holds several agents. They all work for the same person, so they share that
-- person's name and "about you", and the same connected apps: `composio_user_id` moves from
-- the membership (one per agent) to the account (one per person). Each agent keeps its own
-- name, profile, instructions, chats, tasks, and skills.
--
-- Backward compatible: workspace_members.composio_user_id stays (code serving during a deploy
-- still reads it), and each existing account takes the id of the person's oldest membership,
-- so the connections they made there keep working in every agent.

create table public.accounts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  about text not null default '' check (char_length(about) <= 4000),
  -- Stable, opaque id for this person's tool connections (Composio "user id").
  composio_user_id text not null unique default ('lj_' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.accounts (user_id, composio_user_id)
select distinct on (m.user_id) m.user_id, m.composio_user_id
from public.workspace_members m
order by m.user_id, m.created_at asc, m.workspace_id asc
on conflict do nothing;

alter table public.accounts enable row level security;

-- Only the person themself. Rows are created by ensure_account(); the Composio id is never
-- chosen or changed by a session.
create policy "read own account" on public.accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "update own account" on public.accounts
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on table public.accounts from anon, authenticated;
grant select on table public.accounts to authenticated;
grant update (display_name, about, updated_at) on table public.accounts to authenticated;

-- The caller's account, created on first use. A person who already has an agent keeps the
-- Composio id of their oldest membership (someone who signed up while this migration was
-- deploying); anyone else gets a new one.
create function public.ensure_account()
returns public.accounts language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  acct public.accounts;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into acct from public.accounts a where a.user_id = uid;
  if found then
    return acct;
  end if;
  insert into public.accounts (user_id, composio_user_id)
  values (
    uid,
    coalesce(
      (select m.composio_user_id from public.workspace_members m
        where m.user_id = uid order by m.created_at asc, m.workspace_id asc limit 1),
      'lj_' || replace(gen_random_uuid()::text, '-', '')
    )
  )
  on conflict (user_id) do nothing;
  select * into acct from public.accounts a where a.user_id = uid;
  return acct;
end;
$$;

revoke execute on function public.ensure_account() from public, anon;
grant execute on function public.ensure_account() to authenticated;
