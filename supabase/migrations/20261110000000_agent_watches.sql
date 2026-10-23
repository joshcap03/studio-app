-- Watches: a task that runs when something happens in one of the member's connected apps
-- (docs/watches.md). Composio watches the app and calls the app's webhook; the background
-- worker matches each event to its watch here and queues a run of the watch's task, folding
-- events that arrive close together into one run.
--
-- A watch belongs to one member's task and is private to them, like the task. Events are
-- accepted only for the member Composio signed them for: the worker's claim matches the
-- event's Composio user id to the watch owner's accounts.composio_user_id, which members can't
-- change, so attaching someone else's trigger id to a watch gets nothing.

------------------------------------------------------------------------------------------
-- Tables

create table public.agent_task_watches (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  toolkit text not null check (toolkit ~ '^[a-z0-9_]{1,60}$'),
  trigger_slug text not null check (trigger_slug ~ '^[A-Z0-9_]{1,100}$'),
  trigger_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(trigger_config) = 'object' and pg_column_size(trigger_config) <= 2048),
  -- Composio's trigger instance, created under the member's own Composio user id.
  composio_trigger_id text unique check (composio_trigger_id is null or char_length(composio_trigger_id) between 1 and 100),
  -- Follows its task: watching while the task is active, paused otherwise; broken when the
  -- app's connection went away or Composio refused the trigger (problem says which).
  status text not null default 'paused' check (status in ('watching', 'paused', 'broken')),
  problem text check (problem is null or problem in ('disconnected', 'refused', 'removed')),
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One watch per task, for now.
  unique (task_id),
  unique (id, workspace_id, user_id),
  foreign key (task_id, workspace_id, user_id)
    references public.agent_tasks (id, workspace_id, user_id) on delete cascade
);

-- Events already taken, so a webhook Composio delivers again never starts a second run.
create table public.agent_watch_events (
  watch_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  -- Composio's webhook-id.
  event_id text not null check (char_length(event_id) between 1 and 100),
  run_id uuid,
  received_at timestamptz not null default now(),
  primary key (watch_id, event_id),
  foreign key (watch_id, workspace_id, user_id)
    references public.agent_task_watches (id, workspace_id, user_id) on delete cascade
);
create index agent_watch_events_age on public.agent_watch_events (watch_id, received_at);

-- A watch run carries what happened: up to 20 events ({ id, at, summary, data }), a count of
-- the ones that arrived after those, and when it starts (it waits a little for more).
alter table public.agent_task_runs
  add column events jsonb check (events is null or (jsonb_typeof(events) = 'array'
    and jsonb_array_length(events) <= 20 and pg_column_size(events) <= 131072)),
  add column more_events integer not null default 0 check (more_events >= 0),
  add column not_before timestamptz;
create index agent_task_runs_waiting on public.agent_task_runs (task_id, not_before)
  where status = 'queued' and events is not null;

-- A watch run's message says what started it ("Watching · New email from …"), which needs a
-- little more room than a schedule's label.
alter table public.messages drop constraint messages_origin_check;
alter table public.messages add constraint messages_origin_check
  check (origin is null or (jsonb_typeof(origin) = 'object' and pg_column_size(origin) <= 1024));

-- At most 10 watches per member in a workspace. Serialized per member so concurrent inserts
-- can't overshoot; the count runs under the caller's RLS, which is exactly their rows.
create function public.agent_task_watches_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('agent_task_watches:' || new.workspace_id::text || ':' || new.user_id::text, 0));
  if (select count(*) from public.agent_task_watches w
      where w.workspace_id = new.workspace_id and w.user_id = new.user_id) >= 10 then
    raise exception 'watch limit reached' using errcode = 'P0001', hint = 'watch_limit';
  end if;
  return new;
end;
$$;
create trigger agent_task_watches_cap before insert on public.agent_task_watches
  for each row execute function public.agent_task_watches_cap();

------------------------------------------------------------------------------------------
-- Row Level Security: the owning member, inside a workspace they belong to.

alter table public.agent_task_watches enable row level security;
alter table public.agent_watch_events enable row level security;

create policy "own watches" on public.agent_task_watches
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Members read which events their watches took; only the claim functions below write them.
create policy "own watch events" on public.agent_watch_events
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.agent_task_watches, public.agent_watch_events from anon;
revoke insert, update, delete on table public.agent_watch_events from authenticated;
-- Ids, tenancy, and when the watch last heard something are the database's.
revoke update on table public.agent_task_watches from authenticated;
grant update (toolkit, trigger_slug, trigger_config, composio_trigger_id, status, problem, updated_at)
  on table public.agent_task_watches to authenticated;
-- A watch run that can't start yet (its conversation is busy) waits longer.
grant update (not_before) on table public.agent_task_runs to authenticated;

revoke execute on function public.agent_task_watches_cap() from public, anon, authenticated;

------------------------------------------------------------------------------------------
-- Claiming an event

-- Takes one event for one watch and returns the run it belongs to, and whether the caller
-- should start it (start_run: a new run, or a repeat whose run is still queued; starting is
-- idempotent per run); nothing when the watch isn't watching or its task isn't active. An event joins the task's
-- watch run that hasn't started yet (one waiting for `not_before`), up to 20 events and then
-- only counted; otherwise it starts a new run that waits `p_wait` for more. A watch gets at most
-- 6 runs an hour: a seventh waits until the oldest of the last six is an hour old.
-- Called only by the two functions after it.
create function public.claim_watch_event(p_watch uuid, p_event_id text, p_event jsonb, p_wait interval)
returns table (run_id uuid, task_id uuid, workspace_id uuid, user_id uuid, not_before timestamptz, start_run boolean)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  w record;
  r record;
  last_six timestamptz[];
  due timestamptz;
  new_run uuid;
begin
  if jsonb_typeof(p_event) is distinct from 'object' or pg_column_size(p_event) > 6144 then
    raise exception 'invalid event' using errcode = '22023';
  end if;

  -- Locking the watch serializes its events, so folding and the hourly cap see each other.
  select tw.id, tw.task_id, tw.workspace_id, tw.user_id into w
    from public.agent_task_watches tw
    join public.agent_tasks t on t.id = tw.task_id
    where tw.id = p_watch and tw.status = 'watching' and t.status = 'active'
    for update of tw;
  if not found then
    return;
  end if;

  insert into public.agent_watch_events (watch_id, workspace_id, user_id, event_id)
    values (w.id, w.workspace_id, w.user_id, p_event_id)
    on conflict do nothing;
  if not found then
    -- Taken before: its run again while it's still queued, so a caller that failed before
    -- starting it can (its start is idempotent per run); nothing once it has started.
    return query select q.id, w.task_id, w.workspace_id, w.user_id, q.not_before, true
      from public.agent_watch_events e join public.agent_task_runs q on q.id = e.run_id
      where e.watch_id = w.id and e.event_id = p_event_id and q.status = 'queued';
    return;
  end if;
  update public.agent_task_watches set last_event_at = now() where id = w.id;
  -- A week is far longer than any provider redelivers.
  delete from public.agent_watch_events e where e.watch_id = w.id and e.received_at < now() - interval '7 days';

  select q.id, q.not_before, q.events into r
    from public.agent_task_runs q
    where q.task_id = w.task_id and q.status = 'queued' and q.events is not null and q.not_before > now()
    order by q.not_before
    limit 1
    for update;
  if found then
    if jsonb_array_length(r.events) < 20 then
      update public.agent_task_runs set events = events || jsonb_build_array(p_event), updated_at = now() where id = r.id;
    else
      update public.agent_task_runs set more_events = more_events + 1, updated_at = now() where id = r.id;
    end if;
    update public.agent_watch_events e set run_id = r.id where e.watch_id = w.id and e.event_id = p_event_id;
    return query select r.id, w.task_id, w.workspace_id, w.user_id, r.not_before, false;
    return;
  end if;

  due := now() + p_wait;
  select array_agg(s.scheduled_for order by s.scheduled_for) into last_six
    from (select q.scheduled_for from public.agent_task_runs q
          where q.task_id = w.task_id and q.events is not null and q.scheduled_for > now() - interval '1 hour'
          order by q.scheduled_for desc limit 6) s;
  if coalesce(array_length(last_six, 1), 0) >= 6 then
    due := greatest(due, last_six[1] + interval '1 hour');
  end if;

  insert into public.agent_task_runs (task_id, workspace_id, user_id, scheduled_for, status, events, not_before)
    values (w.task_id, w.workspace_id, w.user_id, clock_timestamp(), 'queued', jsonb_build_array(p_event), due)
    returning id into new_run;
  update public.agent_watch_events e set run_id = new_run where e.watch_id = w.id and e.event_id = p_event_id;
  return query select new_run, w.task_id, w.workspace_id, w.user_id, due, true;
end;
$$;

-- For the background worker (service_role only): an event Composio signed for one of its
-- trigger instances. Accepted only when the trigger's watch belongs to the member whose
-- Composio user id the event names.
create function public.worker_claim_watch_event(p_trigger_id text, p_composio_user_id text, p_event_id text, p_event jsonb)
returns table (run_id uuid, task_id uuid, workspace_id uuid, user_id uuid, not_before timestamptz, start_run boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  found_watch uuid;
begin
  select tw.id into found_watch
    from public.agent_task_watches tw
    join public.accounts a on a.user_id = tw.user_id
    where tw.composio_trigger_id = p_trigger_id and a.composio_user_id = p_composio_user_id;
  if found_watch is null then
    return;
  end if;
  return query select * from public.claim_watch_event(found_watch, p_event_id, p_event, interval '60 seconds');
end;
$$;

-- For a member trying their own watch (the app's test event, refused in production): the
-- same claim, on a watch of theirs, waiting at most five minutes.
create function public.claim_own_watch_event(p_watch uuid, p_event_id text, p_event jsonb, p_wait_seconds integer default 60)
returns table (run_id uuid, task_id uuid, workspace_id uuid, user_id uuid, not_before timestamptz, start_run boolean)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.agent_task_watches tw
                 where tw.id = p_watch and tw.user_id = auth.uid() and public.is_workspace_member(tw.workspace_id)) then
    raise exception 'not your watch' using errcode = '42501';
  end if;
  return query select * from public.claim_watch_event(p_watch, p_event_id, p_event,
    make_interval(secs => greatest(0, least(coalesce(p_wait_seconds, 60), 300))));
end;
$$;

revoke execute on function public.claim_watch_event(uuid, text, jsonb, interval) from public, anon, authenticated;
revoke execute on function public.worker_claim_watch_event(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.worker_claim_watch_event(text, text, text, jsonb) to service_role;
revoke execute on function public.claim_own_watch_event(uuid, text, jsonb, integer) from public, anon;
grant execute on function public.claim_own_watch_event(uuid, text, jsonb, integer) to authenticated;
