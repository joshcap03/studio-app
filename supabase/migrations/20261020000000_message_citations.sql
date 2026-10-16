-- Sources a reply cites as [n] (link, quoted passage, whether the quote was found in what
-- this run's tools returned). Covered by the existing messages policies, so it is as private
-- as the reply it belongs to.
alter table public.messages
  add column citations jsonb check (citations is null or (jsonb_typeof(citations) = 'array' and pg_column_size(citations) <= 65536));
grant update (citations) on table public.messages to authenticated;
