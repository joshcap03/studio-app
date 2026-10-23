-- A claimed run the worker couldn't start (the app unreachable, the member unable to sign in)
-- used to stay 'queued' forever, so the member saw nothing and the failure lived only in the
-- worker's logs. The worker now settles it with worker_settle_unstarted_run (service_role
-- only, like the other worker_* functions). It touches a run only while it's still queued: one
-- the app already began is the app's to settle.

create function public.worker_settle_unstarted_run(p_run uuid, p_status text, p_reason text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('skipped', 'failed') then
    raise exception 'unknown run status' using errcode = '22023';
  end if;
  update public.agent_task_runs set status = p_status, reason = left(p_reason, 500), updated_at = now()
    where id = p_run and status = 'queued';
  return found;
end;
$$;

revoke execute on function public.worker_settle_unstarted_run(uuid, text, text) from public, anon, authenticated;
grant execute on function public.worker_settle_unstarted_run(uuid, text, text) to service_role;

-- Runs already stranded that way. A queued run is started within minutes (sign-in deferrals
-- add at most half an hour), so one scheduled over a day ago never will be.
update public.agent_task_runs set status = 'failed', reason = 'not_started', updated_at = now()
  where status = 'queued' and scheduled_for < now() - interval '1 day';
