-- A member's thumbs up or down on a reply, with the reasons they picked and an optional note.
-- Covered by the existing messages policies, so feedback is as private as the reply it rates.
alter table public.messages
  add column feedback jsonb check (
    feedback is null or (
      role = 'assistant'
      and jsonb_typeof(feedback) = 'object'
      and feedback->>'rating' in ('up', 'down')
      and pg_column_size(feedback) <= 4096
    )
  );
grant update (feedback) on table public.messages to authenticated;
