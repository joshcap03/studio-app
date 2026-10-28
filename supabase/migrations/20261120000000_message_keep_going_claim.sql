-- Keep going with no page open: a chat reply that carries a job on (keep_going) is carried on by
-- the member's page when it's open, and otherwise by the background worker, which signs in as the
-- member and asks the app to (POST /api/conversations/<id>/keep-going), as it does for a task's run.
--
-- continued_at: when the reply's job was taken to carry on (or ended by the member's Stop). Every
-- carry-on claims it first with a conditional update, so the page, the worker, and a task's run
-- never start the same next reply twice. Saved by the turn under the member's session.

alter table public.messages add column continued_at timestamptz;

grant update (continued_at) on table public.messages to authenticated;

-- Whether a reply is still waiting to be carried on: its conversation's latest message, the
-- member's own, with keep_going and not yet taken. The worker asks before it signs in as the member,
-- so a reply their page already carried on costs no sign-in. Service role only, like the other
-- worker_* functions; it reads, and changes nothing.
create function public.worker_reply_waiting(p_reply uuid, p_conversation uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_reply
      and m.conversation_id = p_conversation
      and m.user_id = p_user
      and m.role = 'assistant'
      and m.status in ('complete', 'error')
      and m.keep_going is not null
      and m.continued_at is null
      and not exists (
        select 1 from public.messages later
        where later.conversation_id = m.conversation_id
          and later.id <> m.id
          and later.created_at >= m.created_at
      )
  );
$$;

revoke execute on function public.worker_reply_waiting(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.worker_reply_waiting(uuid, uuid, uuid) to service_role;
