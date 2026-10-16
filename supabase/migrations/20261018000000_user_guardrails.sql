-- Personal guardrails: rules a person sets for how the agent works with them, which go to the
-- agent ahead of every other instruction in every workspace they belong to.
--
-- A guardrail is a commitment the person makes ahead of time, so the app can't change it: users
-- may read their own row and nothing else, and no role a session can hold may insert, update,
-- or delete one. It's set and removed only with admin access to the database.

create table public.user_guardrails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  instructions text not null check (char_length(instructions) between 1 and 8000),
  created_at timestamptz not null default now()
);

alter table public.user_guardrails enable row level security;

create policy "read own guardrail" on public.user_guardrails
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.user_guardrails from anon, authenticated;
grant select on table public.user_guardrails to authenticated;
