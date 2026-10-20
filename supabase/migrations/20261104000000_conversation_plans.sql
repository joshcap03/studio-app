-- A plan for any piece of work with several steps, not only a task's or the setup interview's,
-- and what done looks like for it.
--
-- The agent keeps a conversation's plan with update_plan, as it does a task's: the steps and,
-- in its own words, the goal ("Done means …"). A task's plan stays on the task and the setup
-- checklist in workspace_settings.setup; an ordinary conversation's lives on the conversation,
-- covered by its existing policy ("own conversations"), so it's as private as the chat. Steps
-- are checked like a task's (public.is_valid_task_plan). A task gains a goal too, which its
-- member can edit. Additive only: the running code never reads these columns.
alter table public.conversations
  add column plan jsonb not null default '[]'::jsonb check (public.is_valid_task_plan(plan)),
  add column goal text check (goal is null or char_length(goal) between 1 and 200),
  add column plan_updated_at timestamptz;
grant update (plan, goal, plan_updated_at) on table public.conversations to authenticated;

alter table public.agent_tasks
  add column goal text check (goal is null or char_length(goal) between 1 and 200);
grant update (goal) on table public.agent_tasks to authenticated;

-- Whose move it is in some of the caller's conversations in one agent, for the sidebar: the
-- latest message's role and status, when it last changed, and what it still asks of the member,
-- first: a pending approval, then an unanswered form, proposal or merge (in the order shown),
-- then questions. Other cards (an offer to talk, say) ask nothing. Runs as the caller, so RLS
-- keeps it to their own rows as well; ids that aren't theirs in this agent return nothing. The
-- app decides what the state means (src/lib/chat/move.ts), including when a quiet "streaming"
-- message counts as interrupted.
create function public.conversation_moves(p_workspace uuid, p_ids uuid[])
returns table (conversation_id uuid, role text, status text, updated_at timestamptz, open_ask text)
language sql stable security invoker set search_path = '' as $$
  select c.id, m.role, m.status, m.updated_at,
    coalesce(
      case when exists (select 1 from public.approvals a where a.message_id = m.id and a.status = 'pending') then 'approval' end,
      (select case b.block ->> 'kind' when 'memory-merge' then 'merge' else b.block ->> 'kind' end
       from jsonb_array_elements(coalesce(m.ui, '[]'::jsonb)) with ordinality as b (block, n)
       where b.block ->> 'kind' in ('form', 'proposal', 'memory-merge')
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

revoke execute on function public.conversation_moves(uuid, uuid[]) from public, anon;
grant execute on function public.conversation_moves(uuid, uuid[]) to authenticated;
