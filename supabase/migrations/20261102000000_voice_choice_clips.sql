-- How an agent sounds to one member, and speech outside calls.
--
-- A member picks the voice each agent speaks with on calls: a key from Studio's own catalog
-- (src/lib/voice/voices.ts), which the app maps to the provider's voice. It sits with the name
-- and manner on their companion row and, like the manner, can be set before the agent has
-- introduced itself. Additive only: the running code never reads it.
alter table public.agent_companions
  add column voice text check (voice is null or voice ~ '^[a-z0-9-]{1,40}$');

grant insert (voice) on table public.agent_companions to authenticated;
grant update (voice) on table public.agent_companions to authenticated;

-- Speech outside calls (a voice preview now; later a voice note, a voice message turned into
-- text) is billed by the voice provider too, so it counts against the same daily voice time as
-- calls. One row per clip charged. Studio stores no audio and no words here: only how long the
-- clip was and a key naming it, so the same clip isn't charged twice in a day. The app makes
-- that key with a secret of its own, so a row a member writes by calling claim_voice_clip()
-- directly never matches a clip the app charges.
--
-- Rows are private to the member they were charged to. Members never write them: only
-- claim_voice_clip() does, under the same lock and daily total as claim_voice(). They outlast
-- the agent they were spent in (an owner can delete it), since the time was the person's.
create table public.voice_clips (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete set null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preview', 'note', 'transcribe')),
  ref text not null check (char_length(ref) between 1 and 200),
  seconds integer not null check (seconds between 0 and 3600),
  created_at timestamptz not null default now()
);
create index voice_clips_by_user_recent on public.voice_clips (user_id, created_at desc);

alter table public.voice_clips enable row level security;

create policy "read own voice clips" on public.voice_clips
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.voice_clips from anon, authenticated;
grant select (id, workspace_id, user_id, kind, ref, seconds, created_at) on table public.voice_clips to authenticated;

-- Calls outlast their agent the same way: deleting an agent (and making another) mustn't hand
-- back the day's voice time. A call whose agent is gone still counts and is seen by no one, as
-- the read policy needs membership. The running code reads calls only by id, inside its agent.
alter table public.voice_sessions alter column workspace_id drop not null;
alter table public.voice_sessions drop constraint voice_sessions_workspace_id_fkey;
alter table public.voice_sessions
  add constraint voice_sessions_workspace_id_fkey foreign key (workspace_id) references public.workspaces (id) on delete set null;

-- Voice time a person has spent or been granted today (UTC), across all their agents: their
-- clips, each ended call for the time it ran (never past its limit), and each open call for all
-- the time it was granted, since it may run that long; so a clip can't spend time a call has
-- been promised. (claim_voice ends the member's open calls before it counts.) Only the claim
-- functions below call it, as their owner.
create function public.voice_seconds_today(p_user uuid) returns integer
language sql stable set search_path = '' as $$
  select (
    select coalesce(sum(case when v.ended_at is null then v.max_seconds else public.voice_seconds(v) end), 0)
      from public.voice_sessions v
      where v.user_id = p_user and v.started_at >= date_trunc('day', now())
  )::integer + (
    select coalesce(sum(c.seconds), 0)
      from public.voice_clips c
      where c.user_id = p_user and c.created_at >= date_trunc('day', now())
  )::integer;
$$;

revoke execute on function public.voice_seconds_today(uuid) from public, anon, authenticated;

-- claim_voice as before (see 20261030000000_voice_sessions.sql), with today's clips counted
-- against the daily voice time too, and missing limits refused.
create or replace function public.claim_voice(
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
  if p_daily_seconds is null or p_call_seconds is null or p_daily_seconds < 0 or p_call_seconds < 1 then
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

  used := public.voice_seconds_today(uid);

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

-- Charges one clip of `p_seconds` to the caller in workspace `ws`, if their voice time today
-- allows it (an open call counts for all the time it was granted). The same clip (`p_kind` and
-- `p_ref`) again the same day is already paid for and charges nothing. Returns the clip's row
-- id and the seconds charged now, or `refused`: 'daily' when it would go past today's voice
-- time. The limits come from the app; a member calling this directly only charges themselves.
create function public.claim_voice_clip(
  ws uuid,
  p_kind text,
  p_ref text,
  p_seconds integer,
  p_daily_seconds integer
)
returns table (clip_id uuid, seconds integer, refused text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  existing uuid;
  created uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_kind not in ('preview', 'note', 'transcribe') then
    raise exception 'unknown clip kind' using errcode = '22023';
  end if;
  if p_ref is null or char_length(p_ref) not between 1 and 200 then
    raise exception 'bad clip ref' using errcode = '22023';
  end if;
  if p_seconds is null or p_seconds not between 0 and 3600 or p_daily_seconds is null or p_daily_seconds < 0 then
    raise exception 'bad voice limits' using errcode = '22023';
  end if;
  if not public.is_workspace_member(ws) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  -- The same lock as claim_voice, so a clip and a call starting at once can't both spend the
  -- last of today's time.
  perform pg_advisory_xact_lock(hashtextextended('claim_voice:user:' || uid::text, 0));

  select c.id into existing
    from public.voice_clips c
    where c.user_id = uid and c.kind = p_kind and c.ref = p_ref and c.created_at >= date_trunc('day', now())
    limit 1;
  if existing is not null then
    return query select existing, 0, null::text;
    return;
  end if;

  if public.voice_seconds_today(uid) + p_seconds > p_daily_seconds then
    return query select null::uuid, 0, 'daily'::text;
    return;
  end if;

  insert into public.voice_clips (workspace_id, user_id, kind, ref, seconds)
    values (ws, uid, p_kind, p_ref, p_seconds)
    returning id into created;
  return query select created, p_seconds, null::text;
end;
$$;

revoke execute on function public.claim_voice_clip(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.claim_voice_clip(uuid, text, text, integer, integer) to authenticated;
