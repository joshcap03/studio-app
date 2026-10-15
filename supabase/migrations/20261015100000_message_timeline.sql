-- "Why?" investigations: the timeline the agent reported for a reply (dated events across
-- the member's apps, each citing a record this run read, plus likely causes). Covered by the
-- existing messages policies, so it is as private as the reply it belongs to.
alter table public.messages
  add column timeline jsonb check (timeline is null or (jsonb_typeof(timeline) = 'object' and pg_column_size(timeline) <= 65536));
grant update (timeline) on table public.messages to authenticated;
