-- Files the agent's browser got for the member (a shipping label, a receipt), saved on the reply
-- that got them (save_file, src/lib/browser-files.ts). They're ordinary attachments, kept under
-- the member's own folder and session like any other; `browser_md5` marks one from the browser and
-- holds its digest, so a later run can hand the agent a Composio file key for it (to attach it to
-- an email) without reading the file again. Set when the row is made; members can't change it.
alter table public.attachments add column browser_md5 text check (browser_md5 is null or browser_md5 ~ '^[0-9a-f]{32}$');
create index attachments_from_browser on public.attachments (user_id, created_at desc) where browser_md5 is not null;
