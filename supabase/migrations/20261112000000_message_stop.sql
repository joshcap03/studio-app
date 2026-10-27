-- A stop the member asked for on a reply still streaming. Runs aren't tied to the server that
-- gets the Stop request (each request may land on another instance), so the server running the
-- reply checks this every few seconds and stops it. Cleared whenever the reply starts streaming
-- again (it carries on after an approval). Covered by the existing messages policies, so only
-- the member can ask, and set under their session. Additive only: older code never reads it.
alter table public.messages add column stop_requested_at timestamptz;
grant update (stop_requested_at) on table public.messages to authenticated;
