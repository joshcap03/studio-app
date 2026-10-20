-- A voice note on a reply: the words the agent's voice says when the member taps play (the gist
-- of a reply to their voice message, or a task run's report). Only the words are kept: the
-- audio is made on each play and sent straight back, never stored. Covered by the existing
-- messages policies, so a note is as private as the reply it belongs to, and saved by the turn
-- under the member's session. Additive only: the running code never reads it.
alter table public.messages
  add column voice_note jsonb,
  add constraint messages_voice_note_shape check (
    voice_note is null or (
      role = 'assistant'
      and jsonb_typeof(voice_note) = 'object'
      and voice_note - 'script' - 'source' = '{}'::jsonb
      and jsonb_typeof(voice_note -> 'script') = 'string'
      and char_length(voice_note ->> 'script') between 1 and 600
      and voice_note ->> 'source' in ('reply', 'summary')
    )
  );
grant update (voice_note) on table public.messages to authenticated;
