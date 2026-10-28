-- Files from the agent's browser (src/lib/browser-files.ts) may also be spreadsheets and zips
-- (exports, statements), which are only ever downloaded by the member, never read by the agent.
-- Storage keeps the same per-member quota. What a member may attach to a message is still the
-- app's own list (ATTACHMENT_TYPES), checked before any upload.
create or replace function public.attachment_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(storage.extension(p_name)) = any (array[
      'pdf', 'docx', 'csv', 'txt', 'md', 'json', 'xml', 'html', 'yaml', 'yml', 'png', 'jpg', 'jpeg',
      'xlsx', 'xls', 'zip'
    ])
    and coalesce((
      select sum((o.metadata ->> 'size')::bigint)
      from storage.objects o
      where o.bucket_id = 'attachments'
        and (storage.foldername(o.name))[1] = (storage.foldername(p_name))[1]
        and (storage.foldername(o.name))[2] = (select auth.uid())::text
    ), 0) < 1073741824;
$$;

-- The bucket checks each object's type too.
update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct t) from unnest(coalesce(allowed_mime_types, '{}') || array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/zip'
  ]) as t
)
where id = 'attachments' and allowed_mime_types is not null;
