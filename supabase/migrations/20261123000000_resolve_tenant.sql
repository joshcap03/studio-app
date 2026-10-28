-- One round trip for what every request resolves before any work: the caller's account
-- (created on first use, as ensure_account does) and their memberships, oldest first, with
-- each agent's name. Until now that took two queries per request on top of the session check.
--
-- Security definer so the account can be created; everything it reads is filtered by the
-- caller's own id, which is the same set Row Level Security would give them.

create function public.resolve_tenant()
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
        jsonb_build_object('workspace_id', m.workspace_id, 'role', m.role, 'name', w.name)
        order by m.created_at asc, m.workspace_id asc
      )
      from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      where m.user_id = uid
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.resolve_tenant() from public, anon;
grant execute on function public.resolve_tenant() to authenticated;
