-- Keep going: a reply that ran out of its time with the job unfinished, and nothing left that
-- needs the member, carries on in the next reply by itself instead of asking them to say so.
--
-- The agent says so with the gateway's keep_going tool (what's left, in a line), saved on its
-- reply. While that reply is the conversation's latest, the member's page starts the next one
-- (a "continue" turn, no message of theirs), up to a cap; anything they send or stop ends it.
-- Covered by the existing messages policies, saved by the turn under the member's session.
-- Additive only: the running code never reads it.

alter table public.messages
  add column keep_going text,
  add constraint messages_keep_going_shape check (
    keep_going is null or (role = 'assistant' and char_length(keep_going) between 1 and 300)
  );

grant update (keep_going) on table public.messages to authenticated;
