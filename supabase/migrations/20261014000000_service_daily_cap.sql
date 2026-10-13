-- Service-wide daily cap on agent runs, so open sign-ups can't run up the model bill.
--
-- Usage rows are only visible to the member who made them, so the app can't count every
-- tenant's runs under RLS. This answers one yes/no question across all tenants without
-- returning anyone's rows, workspace ids, or counts.

create index usage_by_day on public.usage_events (created_at) where kind = 'agent_run';

create function public.service_runs_at_limit(p_limit integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and p_limit > 0 and (
    select count(*) from public.usage_events u
    where u.kind = 'agent_run' and u.created_at > date_trunc('day', now())
  ) >= p_limit;
$$;

revoke execute on function public.service_runs_at_limit(integer) from public, anon;
grant execute on function public.service_runs_at_limit(integer) to authenticated;
