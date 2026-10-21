-- The person's saved sign-ins for the agent's browser, and the browser handed to them as a card.
--
-- accounts.browser_context: one Browserbase context per person (shared by all their agents, like
-- their connected apps), so a site they signed in to in the agent's browser stays signed in. Sealed with a MAC the app makes with its own Browserbase key
-- (src/lib/browser-signins.ts), because the person can write this column: an id they wrote
-- themselves fails the check. Only the id is stored; the sign-ins live at Browserbase.
-- Additive: the running code never reads it.
alter table public.accounts
  add column browser_context text check (browser_context is null or char_length(browser_context) between 1 and 200);

grant update (browser_context) on table public.accounts to authenticated;

-- A card handing the member the agent's browser ("browser") waits on them like a form does, so
-- the sidebar counts it as their move. Otherwise the same as before.
create or replace function public.conversation_moves(p_workspace uuid, p_ids uuid[])
returns table (conversation_id uuid, role text, status text, updated_at timestamptz, open_ask text)
language sql stable security invoker set search_path = '' as $$
  select c.id, m.role, m.status, m.updated_at,
    coalesce(
      case when exists (select 1 from public.approvals a where a.message_id = m.id and a.status = 'pending') then 'approval' end,
      (select case b.block ->> 'kind' when 'memory-merge' then 'merge' else b.block ->> 'kind' end
       from jsonb_array_elements(coalesce(m.ui, '[]'::jsonb)) with ordinality as b (block, n)
       where b.block ->> 'kind' in ('form', 'proposal', 'memory-merge', 'browser')
         and not (coalesce(m.ui_response, '{}'::jsonb) ? coalesce(b.block ->> 'id', ''))
       order by b.n
       limit 1),
      case when jsonb_array_length(coalesce(m.questions, '[]'::jsonb)) > 0 then 'question' end
    )
  from public.conversations c
  cross join lateral (
    select x.id, x.role, x.status, x.updated_at, x.questions, x.ui, x.ui_response
    from public.messages x
    where x.conversation_id = c.id
    order by x.seq desc
    limit 1
  ) m
  where c.id = any (p_ids)
    and c.workspace_id = p_workspace
    and c.user_id = (select auth.uid())
    and cardinality(p_ids) <= 500;
$$;
