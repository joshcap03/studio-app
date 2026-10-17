-- The background worker that runs members' scheduled tasks.
--
-- The worker holds the project's secret key only to call the two worker_* functions below
-- (service_role only) and to open a short-lived session as a task's member. Everything else
-- it does runs as that member, under RLS, through the same turn engine as chat.
--
-- Task runs are claimed against their own limits: they don't count toward (or wait on) the
-- member's chat concurrency, and they have a separate per-workspace daily cap. They still
-- count toward the service-wide daily cap, which guards the model bill.

------------------------------------------------------------------------------------------
-- Usage kinds

alter table public.usage_events drop constraint usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (kind in ('agent_run', 'task_run'));
create index usage_by_day_task on public.usage_events (created_at) where kind = 'task_run';

------------------------------------------------------------------------------------------
-- claim_run, now per kind. Same arguments as before plus p_kind, so the previous deployment
-- keeps working (it never passes p_kind) until this one goes live.

drop function public.claim_run(uuid, integer, integer, integer, integer, uuid);

-- Returns null when the run may start (and records it), or which limit it would exceed:
-- 'concurrent', 'per_minute', 'workspace_day', or 'service_day'. For 'task_run', p_per_day is
-- the workspace's daily task cap.
create function public.claim_run(
  ws uuid,
  p_concurrent integer,
  p_per_minute integer,
  p_per_day integer,
  p_service_per_day integer default null,
  p_message_id uuid default null,
  p_kind text default 'agent_run'
)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  is_task boolean := p_kind = 'task_run';
  running bigint;
  claimed bigint;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_kind not in ('agent_run', 'task_run') then
    raise exception 'unknown run kind' using errcode = '22023';
  end if;
  if not public.is_workspace_member(ws) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  -- Always taken in this order (member, workspace, service), so claims can't deadlock.
  perform pg_advisory_xact_lock(hashtextextended('claim_run:user:' || uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('claim_run:workspace:' || ws::text, 0));
  if p_service_per_day is not null then
    perform pg_advisory_xact_lock(hashtextextended('claim_run:service', 0));
  end if;

  -- Runs in progress of this kind: streaming replies (a reply is a task run's when it was
  -- claimed as one), plus runs claimed in the last few seconds whose reply doesn't exist yet.
  select count(*) into running from public.messages m
    where m.user_id = uid and m.status = 'streaming' and m.updated_at > now() - interval '5 minutes'
      and exists (select 1 from public.usage_events t where t.message_id = m.id and t.kind = 'task_run') = is_task;
  select count(*) into claimed from public.usage_events u
    where u.user_id = uid and u.kind = p_kind and u.created_at > now() - interval '15 seconds' and u.message_id is not null
      and not exists (select 1 from public.messages m where m.id = u.message_id and m.user_id = uid);
  if running + claimed >= p_concurrent then
    return 'concurrent';
  end if;

  if (select count(*) from public.usage_events u
      where u.user_id = uid and u.kind = p_kind and u.created_at > now() - interval '1 minute') >= p_per_minute then
    return 'per_minute';
  end if;

  if (select count(*) from public.usage_events u
      where u.workspace_id = ws and u.kind = p_kind and u.created_at > date_trunc('day', now())) >= p_per_day then
    return 'workspace_day';
  end if;

  if p_service_per_day is not null and (select count(*) from public.usage_events u
      where u.kind in ('agent_run', 'task_run') and u.created_at > date_trunc('day', now())) >= p_service_per_day then
    return 'service_day';
  end if;

  insert into public.usage_events (workspace_id, user_id, kind, message_id) values (ws, uid, p_kind, p_message_id);
  return null;
end;
$$;

revoke execute on function public.claim_run(uuid, integer, integer, integer, integer, uuid, text) from public, anon;
grant execute on function public.claim_run(uuid, integer, integer, integer, integer, uuid, text) to authenticated;

------------------------------------------------------------------------------------------
-- Worker functions (service_role only)

-- Claims up to p_limit due tasks: each active task whose next run time has passed gets one
-- run for that time. Rows another claim holds are skipped, and a time that already has a
-- run returns that run again rather than a second one, so a dispatcher that crashed before
-- moving next_run_at on just picks the same runs up. The caller moves next_run_at on with
-- worker_set_next_run and starts only runs that are still queued.
create function public.worker_claim_due_tasks(p_limit integer)
returns table (
  run_id uuid,
  task_id uuid,
  workspace_id uuid,
  user_id uuid,
  scheduled_for timestamptz,
  run_status text,
  schedule jsonb,
  timezone text
)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  t record;
begin
  for t in
    select a.id, a.workspace_id, a.user_id, a.next_run_at, a.schedule, a.timezone
    from public.agent_tasks a
    where a.status = 'active' and a.next_run_at is not null and a.next_run_at <= now()
    order by a.next_run_at
    limit greatest(least(p_limit, 500), 0)
    for update skip locked
  loop
    insert into public.agent_task_runs (task_id, workspace_id, user_id, scheduled_for, status)
      values (t.id, t.workspace_id, t.user_id, t.next_run_at, 'queued')
      on conflict (task_id, scheduled_for) do nothing;
    return query
      select r.id, r.task_id, r.workspace_id, r.user_id, r.scheduled_for, r.status, t.schedule, t.timezone
      from public.agent_task_runs r
      where r.task_id = t.id and r.scheduled_for = t.next_run_at;
  end loop;
end;
$$;

-- Moves a task's next run on, only if it's still the time that was claimed (p_due): a member
-- who changed the schedule or paused the task in the meantime keeps what they set.
create function public.worker_set_next_run(p_task uuid, p_due timestamptz, p_next timestamptz)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.agent_tasks set next_run_at = p_next
    where id = p_task and status = 'active' and next_run_at = p_due;
  return found;
end;
$$;

revoke execute on function public.worker_claim_due_tasks(integer) from public, anon, authenticated;
revoke execute on function public.worker_set_next_run(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.worker_claim_due_tasks(integer) to service_role;
grant execute on function public.worker_set_next_run(uuid, timestamptz, timestamptz) to service_role;
