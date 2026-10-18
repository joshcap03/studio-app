-- Voice calls with an agent (the Setup Call preview). One row per call, so a member's daily
-- voice time can be capped: calls are billed per minute by the voice provider, on top of the
-- agent's own runs. Studio stores no audio and no transcript here; what the member says on a
-- call becomes their messages, as when they type.
--
-- Rows are private to the member who called, inside a workspace they belong to. Members never
-- write the timing columns themselves: claim_voice() starts a call (checking the cap, in one
-- transaction) and end_voice_session() ends one at the server's clock, so a call can't be made
-- to look shorter than it was.

create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider in ('mock', 'elevenlabs')),
  -- The provider's id for the call, set once it's been opened.
  provider_conversation_id text check (provider_conversation_id is null or char_length(provider_conversation_id) between 1 and 200),
  started_at timestamptz not null default now(),
  -- The longest this call may run; an open call counts as running until then.
  max_seconds integer not null check (max_seconds between 1 and 7200),
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index voice_sessions_by_user_recent on public.voice_sessions (user_id, started_at desc);

alter table public.voice_sessions enable row level security;

create policy "read own voice sessions" on public.voice_sessions
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
-- The provider's id is recorded once, by the member who opened the call.
create policy "record own voice session id" on public.voice_sessions
  for update to authenticated
  using (user_id = (select auth.uid()) and provider_conversation_id is null and ended_at is null)
  with check (user_id = (select auth.uid()));

revoke all on table public.voice_sessions from anon, authenticated;
grant select on table public.voice_sessions to authenticated;
grant update (provider_conversation_id) on table public.voice_sessions to authenticated;

-- Seconds a call has used: until it ended, or until now while it's open, never past its limit.
create function public.voice_seconds(s public.voice_sessions) returns integer
language sql stable set search_path = '' as $$
  select greatest(0, ceil(extract(epoch from (
    least(coalesce(s.ended_at, now()), s.started_at + make_interval(secs => s.max_seconds)) - s.started_at
  ))))::integer;
$$;

-- Starts a call for the caller in workspace `ws`, if their voice time today allows one.
-- The cap is per person, across all their agents (the voice bill is per person, not per agent).
-- Starting a call ends any other call of theirs still open. Returns the new call's id and how
-- long it may run (the per-call limit or what's left today, whichever is less), or `refused`:
-- 'daily' when less than half a minute is left today.
create function public.claim_voice(
  ws uuid,
  p_provider text,
  p_daily_seconds integer,
  p_call_seconds integer
)
returns table (session_id uuid, max_seconds integer, refused text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  used integer;
  allowed integer;
  created uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_provider not in ('mock', 'elevenlabs') then
    raise exception 'unknown voice provider' using errcode = '22023';
  end if;
  if p_daily_seconds < 0 or p_call_seconds < 1 then
    raise exception 'bad voice limits' using errcode = '22023';
  end if;
  if not public.is_workspace_member(ws) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('claim_voice:user:' || uid::text, 0));

  -- One call at a time: a new one ends the member's others (a reload, a second tab).
  update public.voice_sessions v
    set ended_at = least(now(), v.started_at + make_interval(secs => v.max_seconds))
    where v.user_id = uid and v.ended_at is null;

  select coalesce(sum(public.voice_seconds(v)), 0) into used
    from public.voice_sessions v
    where v.user_id = uid and v.started_at >= date_trunc('day', now());

  allowed := least(p_call_seconds, p_daily_seconds - used);
  if allowed < 30 then
    return query select null::uuid, 0, 'daily'::text;
    return;
  end if;

  insert into public.voice_sessions (workspace_id, user_id, provider, max_seconds)
    values (ws, uid, p_provider, allowed)
    returning id into created;
  return query select created, allowed, null::text;
end;
$$;

revoke execute on function public.claim_voice(uuid, text, integer, integer) from public, anon;
grant execute on function public.claim_voice(uuid, text, integer, integer) to authenticated;

-- Ends one of the caller's calls at the server's clock and returns the seconds it used, or null
-- when it isn't theirs or was already over.
create function public.end_voice_session(p_id uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  ended public.voice_sessions;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.voice_sessions v
    set ended_at = least(now(), v.started_at + make_interval(secs => v.max_seconds))
    where v.id = p_id and v.user_id = auth.uid() and v.ended_at is null
    returning * into ended;
  if ended.id is null then
    return null;
  end if;
  return public.voice_seconds(ended);
end;
$$;

revoke execute on function public.end_voice_session(uuid) from public, anon;
grant execute on function public.end_voice_session(uuid) to authenticated;
revoke execute on function public.voice_seconds(public.voice_sessions) from public, anon;
grant execute on function public.voice_seconds(public.voice_sessions) to authenticated;
