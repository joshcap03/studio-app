-- Atomic agent-run limits.
--
-- The app used to read usage_snapshot(), start the run, then insert a usage row. Requests
-- sent at the same moment all passed the check before any of them was recorded, so a burst
-- got past the concurrency, per-minute, daily, and service-wide limits. claim_run() checks
-- and records in one transaction, serialized per member, per workspace, and (when a
-- service-wide cap is set) across the service.

-- The reply a run writes to, so a claimed run counts as running until its reply exists.
alter table public.usage_events add column message_id uuid;
create index usage_by_user_recent on public.usage_events (user_id, created_at desc);
create index usage_by_message on public.usage_events (message_id) where message_id is not null;

-- A deleted reply (retry, edit, deleted conversation) is no longer a run waiting to start.
create function public.usage_forget_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.usage_events set message_id = null where message_id = old.id;
  return old;
end;
$$;
revoke execute on function public.usage_forget_message() from public, anon, authenticated;
create trigger usage_forget_message after delete on public.messages
  for each row execute function public.usage_forget_message();

-- Returns null when the run may start (and records it), or which limit it would exceed:
-- 'concurrent', 'per_minute', 'workspace_day', or 'service_day'.
create function public.claim_run(
  ws uuid,
  p_concurrent integer,
  p_per_minute integer,
  p_per_day integer,
  p_service_per_day integer default null,
  p_message_id uuid default null
)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  running bigint;
  claimed bigint;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
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

  -- Runs in progress are streaming replies, plus runs claimed in the last few seconds whose
  -- reply doesn't exist yet (the app creates it right after claiming).
  select count(*) into running from public.messages m
    where m.user_id = uid and m.status = 'streaming' and m.updated_at > now() - interval '5 minutes';
  select count(*) into claimed from public.usage_events u
    where u.user_id = uid and u.created_at > now() - interval '15 seconds' and u.message_id is not null
      and not exists (select 1 from public.messages m where m.id = u.message_id and m.user_id = uid);
  if running + claimed >= p_concurrent then
    return 'concurrent';
  end if;

  if (select count(*) from public.usage_events u
      where u.user_id = uid and u.created_at > now() - interval '1 minute') >= p_per_minute then
    return 'per_minute';
  end if;

  if (select count(*) from public.usage_events u
      where u.workspace_id = ws and u.created_at > date_trunc('day', now())) >= p_per_day then
    return 'workspace_day';
  end if;

  if p_service_per_day is not null and (select count(*) from public.usage_events u
      where u.kind = 'agent_run' and u.created_at > date_trunc('day', now())) >= p_service_per_day then
    return 'service_day';
  end if;

  insert into public.usage_events (workspace_id, user_id, kind, message_id) values (ws, uid, 'agent_run', p_message_id);
  return null;
end;
$$;

revoke execute on function public.claim_run(uuid, integer, integer, integer, integer, uuid) from public, anon;
grant execute on function public.claim_run(uuid, integer, integer, integer, integer, uuid) to authenticated;

