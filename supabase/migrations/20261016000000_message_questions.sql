-- Multiple-choice questions the agent asked at the end of a reply (its ask_user tool). The
-- member answers by picking options, which sends their next message. Covered by the existing
-- messages policies, so a question is as private as the reply it belongs to.
alter table public.messages
  add column questions jsonb check (questions is null or (jsonb_typeof(questions) = 'array' and pg_column_size(questions) <= 16384));
grant update (questions) on table public.messages to authenticated;
