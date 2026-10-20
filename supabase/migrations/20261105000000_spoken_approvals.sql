-- Spoken approvals on a call, and the switch that turns them off.
--
-- Whether a request can be approved by voice is decided once, when the agent asks, from the
-- action's own arguments (src/lib/approvals/spoken.ts): money, deletions, sends to more than five
-- people, and anything Studio can't read back stay taps. What it decided is kept with the request
-- (voice_ok, or why it's a tap in tap_only), with the words the call reads back before a yes
-- counts (read_back) and the actions it covers (tools, the provider's own names, for looking
-- into a report). The raw arguments aren't kept.
--
-- A decision records how it was made: 'tap' (a tap, or words typed) or 'voice', with the member's
-- words as the speech-to-text heard them and the call they were said on (decided_call). Only
-- settle_spoken_approval records a spoken decision, and only on the caller's own call in that
-- agent while it's open; members can't write decided_words or decided_call themselves, and the
-- check constraints keep the record honest whatever writes it: a request that isn't voice_ok
-- can't be marked approved by voice, a spoken decision has its words and its call, and nothing
-- else does.
--
-- Additive only: the running code never reads these columns, and every default fails closed
-- (voice_ok false). Earlier requests stay taps.
alter table public.approvals
  add column tools text[] not null default '{}'
    check (cardinality(tools) <= 10 and char_length(array_to_string(tools, ',')) <= 1000),
  add column voice_ok boolean not null default false,
  add column tap_only text check (tap_only in ('money', 'deletion', 'bulk_send', 'unsupported')),
  add column read_back text check (read_back is null or char_length(read_back) between 1 and 400),
  add column decided_via text check (decided_via in ('tap', 'voice')),
  add column decided_words text check (decided_words is null or char_length(decided_words) between 1 and 500),
  -- The member's call a spoken decision was said on (a voice_sessions id, checked when it was
  -- recorded). No foreign key: the record of how it was decided outlives the call's row.
  add column decided_call uuid,
  -- When the member said a spoken approval wasn't what they said (report_spoken_approval).
  add column reported_at timestamptz;

alter table public.approvals
  add constraint approvals_voice_ok_read_back check (not voice_ok or (read_back is not null and tap_only is null)),
  add constraint approvals_spoken_decision
    check (decided_via is distinct from 'voice' or (decided_words is not null and (status <> 'approved' or voice_ok))),
  add constraint approvals_words_spoken check (decided_words is null or decided_via = 'voice'),
  add constraint approvals_spoken_call check (coalesce(decided_via = 'voice', false) = (decided_call is not null)),
  add constraint approvals_reported_spoken check (reported_at is null or decided_via = 'voice');

-- What a member writes themselves: the request as the app classified it when the agent asked
-- (under their session, like every write), and a tap. How a spoken decision was made is never
-- theirs to write (settle_spoken_approval), and neither is a report (report_spoken_approval).
revoke insert on table public.approvals from authenticated;
grant insert (id, workspace_id, user_id, conversation_id, message_id, summary, app, details, status, provider, provider_state, tools, voice_ok, tap_only, read_back)
  on table public.approvals to authenticated;
grant update (decided_via) on table public.approvals to authenticated;

-- Records a decision the member said on a call: one of their own pending requests, on their own
-- call in that agent that's still open, approving only a request classified voice-ok. The app
-- checks the words first (src/lib/voice/approvals.ts). False when any of that doesn't hold.
create function public.settle_spoken_approval(p_approval uuid, p_decision text, p_call uuid, p_words text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  found_approval public.approvals;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'unknown decision' using errcode = '22023';
  end if;
  select * into found_approval
  from public.approvals a
  where a.id = p_approval and a.user_id = uid
  for update;
  if not found or found_approval.status <> 'pending' or not public.is_workspace_member(found_approval.workspace_id) then
    return false;
  end if;
  if p_decision = 'approved' and not found_approval.voice_ok then
    return false;
  end if;
  if not exists (
    select 1 from public.voice_sessions v
    where v.id = p_call
      and v.user_id = uid
      and v.workspace_id = found_approval.workspace_id
      and v.ended_at is null
      and v.started_at + make_interval(secs => v.max_seconds) > now()
  ) then
    return false;
  end if;
  update public.approvals
    set status = p_decision, decided_at = now(), decided_via = 'voice', decided_words = p_words, decided_call = p_call
    where id = found_approval.id;
  return true;
end;
$$;

revoke execute on function public.settle_spoken_approval(uuid, text, uuid, text) from public, anon;
grant execute on function public.settle_spoken_approval(uuid, text, uuid, text) to authenticated;

------------------------------------------------------------------------------------------
-- The trip wire: one report that a spoken approval wasn't what the member said turns spoken
-- approval off for everyone, until someone clears this table with SQL (docs/voice.md). Reports
-- outlive what they point at (set null on delete), so deleting a conversation or an account
-- doesn't turn it back on. No words are copied here: the request keeps its own record, and
-- goes when the member deletes it.

create table public.spoken_approval_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  approval_id uuid unique references public.approvals (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.spoken_approval_reports enable row level security;
create policy "read own spoken approval reports" on public.spoken_approval_reports
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Members only ever read their own reports; rows are written by report_spoken_approval alone.
revoke all on table public.spoken_approval_reports from anon, authenticated;
grant select (id, approval_id, created_at) on table public.spoken_approval_reports to authenticated;

-- Whether the trip wire has gone: any report at all. Says nothing about whose.
create function public.spoken_approvals_off() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.spoken_approval_reports);
$$;

revoke execute on function public.spoken_approvals_off() from public, anon;
grant execute on function public.spoken_approvals_off() to authenticated;

-- The caller says one of their own requests, approved by voice, wasn't what they said. Marks it
-- and trips the wire. False when it isn't theirs in that conversation, or wasn't approved by
-- voice on a call of theirs in that agent (recorded by settle_spoken_approval, so a row written
-- by hand can't trip it); true (once) when it's reported, and again for one already reported.
create function public.report_spoken_approval(p_conversation uuid, p_approval uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  found_approval public.approvals;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into found_approval
  from public.approvals a
  where a.id = p_approval and a.conversation_id = p_conversation and a.user_id = uid
  for update;
  if not found or not public.is_workspace_member(found_approval.workspace_id) then
    return false;
  end if;
  if found_approval.decided_via is distinct from 'voice' or found_approval.status <> 'approved'
    or found_approval.decided_call is null or found_approval.decided_at is null then
    return false;
  end if;
  if not exists (
    select 1 from public.voice_sessions v
    where v.id = found_approval.decided_call
      and v.user_id = uid
      and v.workspace_id = found_approval.workspace_id
      and v.started_at <= found_approval.decided_at
      and (v.ended_at is null or v.ended_at >= found_approval.decided_at)
  ) then
    return false;
  end if;
  if found_approval.reported_at is null then
    update public.approvals set reported_at = now() where id = found_approval.id;
  end if;
  insert into public.spoken_approval_reports (user_id, workspace_id, approval_id)
  values (uid, found_approval.workspace_id, found_approval.id)
  on conflict (approval_id) do nothing;
  return true;
end;
$$;

revoke execute on function public.report_spoken_approval(uuid, uuid) from public, anon;
grant execute on function public.report_spoken_approval(uuid, uuid) to authenticated;
