-- A person may own up to five agents (was three). Deleting one frees its place.
create or replace function public.create_workspace(p_name text, p_business_context text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ws uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.workspaces w where w.created_by = uid) >= 5 then
    raise exception 'workspace limit reached' using errcode = 'P0001', hint = 'workspace_limit';
  end if;
  insert into public.workspaces (name, created_by) values (trim(p_name), uid) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into public.workspace_settings (workspace_id, business_context)
    values (ws, coalesce(p_business_context, ''));
  return ws;
end;
$$;
