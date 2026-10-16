-- Devices where a member turned on notifications (Web Push subscriptions), so a task that
-- finishes or needs their OK while they're away can tell them.
--
-- A subscription belongs to the person, not a workspace: only they can see, add, or remove
-- theirs. The endpoint is a capability URL from their browser's push service, and the keys
-- encrypt what is sent to it, so no one else may read them.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null check (endpoint ~ '^https://' and char_length(endpoint) <= 2000),
  p256dh text not null check (char_length(p256dh) between 1 and 200),
  auth text not null check (char_length(auth) between 1 and 100),
  user_agent text check (char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

alter table public.push_subscriptions enable row level security;

create policy "read own push subscriptions" on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "add own push subscriptions" on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "update own push subscriptions" on public.push_subscriptions
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "remove own push subscriptions" on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, delete on table public.push_subscriptions to authenticated;
grant update (endpoint, p256dh, auth, user_agent) on table public.push_subscriptions to authenticated;
