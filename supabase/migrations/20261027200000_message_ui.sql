-- Interactive cards the agent put under a reply (its show_form and propose_agent tools): a
-- form the member fills in, or a proposed setup for the agent they can apply. `ui` is what the
-- agent asked for; `ui_response` is what the member did with it (keyed by block id), so a card
-- stays answered or applied after a reload. Both are covered by the existing messages
-- policies, so a card is as private as the reply it belongs to.
alter table public.messages
  add column ui jsonb check (ui is null or (jsonb_typeof(ui) = 'array' and pg_column_size(ui) <= 32768)),
  add column ui_response jsonb check (ui_response is null or (jsonb_typeof(ui_response) = 'object' and pg_column_size(ui_response) <= 32768));
grant update (ui, ui_response) on table public.messages to authenticated;
