-- "On Home": whether an agent takes asks from Home, the page across a member's agents, and is a
-- candidate when Home routes one. Every agent so far stays on Home. A new agent made beside an
-- existing one starts as a draft (the app clears the flag) until its owner puts it on Home; off
-- Home, it's reached from the agent menu and its own new-chat screen. Owners change it like the
-- other settings columns.

alter table public.workspace_settings
  add column on_home boolean not null default true;

comment on column public.workspace_settings.on_home is
  'Whether this agent takes asks from Home and is offered there. Off, it is reached from the agent menu only.';

grant update (on_home) on table public.workspace_settings to authenticated;

-- resolve_tenant says which agents are on Home too, so the shell, Home, and the router read it
-- with everything else about the member's agents, in the same round trip.
create or replace function public.resolve_tenant()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  acct public.accounts;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  acct := public.ensure_account();
  return jsonb_build_object(
    'account', jsonb_build_object(
      'display_name', acct.display_name,
      'about', acct.about,
      'composio_user_id', acct.composio_user_id
    ),
    'memberships', coalesce((
      select jsonb_agg(
        jsonb_build_object('workspace_id', m.workspace_id, 'role', m.role, 'name', w.name, 'on_home', coalesce(s.on_home, true))
        order by m.created_at asc, m.workspace_id asc
      )
      from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      left join public.workspace_settings s on s.workspace_id = m.workspace_id
      where m.user_id = uid
    ), '[]'::jsonb)
  );
end;
$$;
