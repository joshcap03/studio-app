-- Upload limits enforced by Storage itself, not only by the app.
--
-- Members can reach Storage directly with their own session (the anon key is public), which
-- skipped the app's file-type allowlist and its cap on files waiting to be sent. Storage now
-- accepts only the app's file types, by declared type and by extension, and each member has
-- a storage quota in each workspace so uploads can't grow without bound.

-- Keep in sync with ATTACHMENT_TYPES in src/lib/types.ts.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv', 'text/plain', 'text/markdown', 'text/html',
  'application/json', 'application/xml', 'application/yaml',
  'image/png', 'image/jpeg'
]
where id = 'attachments';

-- Whether the caller may add this object: an allowed extension, and their files in this
-- workspace's folder (message attachments and project files) under 1 GiB.
create function public.attachment_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(storage.extension(p_name)) = any (array[
      'pdf', 'docx', 'csv', 'txt', 'md', 'json', 'xml', 'html', 'yaml', 'yml', 'png', 'jpg', 'jpeg'
    ])
    and coalesce((
      select sum((o.metadata ->> 'size')::bigint)
      from storage.objects o
      where o.bucket_id = 'attachments'
        and (storage.foldername(o.name))[1] = (storage.foldername(p_name))[1]
        and (storage.foldername(o.name))[2] = (select auth.uid())::text
    ), 0) < 1073741824;
$$;

revoke execute on function public.attachment_upload_allowed(text) from public, anon;
grant execute on function public.attachment_upload_allowed(text) to authenticated;

drop policy "attachments: add own" on storage.objects;
create policy "attachments: add own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.foldername(name))[1] in (
      select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid())
    )
    and public.attachment_upload_allowed(name)
  );
