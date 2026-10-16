-- The agent provider's id for the run that wrote a reply, as its tracing (LangSmith) knows it,
-- so a member's rating of the reply can be attached to that trace. Server-side only: the app
-- never sends it to the browser. Covered by the existing messages policies.
alter table public.messages
  add column trace_id text check (trace_id is null or (role = 'assistant' and length(trace_id) <= 100));
grant update (trace_id) on table public.messages to authenticated;
