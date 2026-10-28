-- Standing files (an agent's files, a project's files) go to the agent service with every run.
-- Until now each run downloaded every one from Storage and uploaded it again. Each row now
-- remembers where the service already has it: which service (`sent_to`, an opaque key for one
-- deployment), the file's id and path there, and when. A run reuses the copy while the service
-- still has it (the adapter checks) and uploads again otherwise. Only these columns may change
-- after a file is added; the member's session writes them for their own files, under RLS.
--
-- Likewise a file from the agent's browser is staged in Composio's file store for sending as an
-- attachment. Composio keeps a staged file for a day, so the key is kept with the row and reused
-- for an hour before it's requested again.

alter table public.agent_files
  add column sent_to text check (char_length(sent_to) <= 200),
  add column sent_id text check (char_length(sent_id) <= 200),
  add column sent_path text check (char_length(sent_path) <= 1000),
  add column sent_at timestamptz;
grant update (sent_to, sent_id, sent_path, sent_at) on table public.agent_files to authenticated;

alter table public.project_files
  add column sent_to text check (char_length(sent_to) <= 200),
  add column sent_id text check (char_length(sent_id) <= 200),
  add column sent_path text check (char_length(sent_path) <= 1000),
  add column sent_at timestamptz;
grant update (sent_to, sent_id, sent_path, sent_at) on table public.project_files to authenticated;

alter table public.attachments
  add column composio_key text check (char_length(composio_key) <= 500),
  add column composio_key_at timestamptz;
grant update (composio_key, composio_key_at) on table public.attachments to authenticated;
