-- A saved card now keeps its security code too, sealed with the rest of the card (the owner chose
-- this, so checking out doesn't ask for it each time). `card_code_saved` says whether it has one,
-- so the fill card asks only for a code a card saved before doesn't have. Saving a card again
-- (same brand, last four, and expiry) replaces the one on file instead of adding a second copy,
-- which is how an older card gets its code.
alter table public.credentials add column card_code_saved boolean not null default false;
grant select (card_code_saved) on table public.credentials to authenticated;

drop function public.save_credential(text, text, text, text, text, text, text, text);

-- Saves one of the caller's logins or cards, replacing a login already saved for the same site
-- and username, or a card already saved with the same brand, last four, and expiry.
-- `p_sealed` is the app's ciphertext. Returns the row's id.
create function public.save_credential(
  p_kind text,
  p_label text,
  p_sealed text,
  p_origin text default null,
  p_username text default null,
  p_card_brand text default null,
  p_card_last4 text default null,
  p_card_exp text default null,
  p_card_code_saved boolean default false
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  existing public.credentials;
  sid uuid;
  cid uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_sealed is null or char_length(p_sealed) not between 1 and 4000 then
    raise exception 'invalid secret' using errcode = '22023';
  end if;
  if p_kind = 'login' then
    select * into existing from public.credentials c
      where c.user_id = uid and c.kind = 'login' and c.origin = p_origin and coalesce(c.username, '') = coalesce(p_username, '');
  elsif p_kind = 'card' then
    select * into existing from public.credentials c
      where c.user_id = uid and c.kind = 'card' and c.card_last4 = p_card_last4 and c.card_exp = p_card_exp
        and coalesce(c.card_brand, '') = coalesce(p_card_brand, '')
      order by c.created_at desc limit 1;
  end if;
  if existing.id is not null then
    perform vault.update_secret(existing.secret_id, p_sealed);
    update public.credentials
      set label = p_label, last_used_at = now(), card_code_saved = (p_kind = 'card' and coalesce(p_card_code_saved, false))
      where id = existing.id;
    return existing.id;
  end if;
  if (select count(*) from public.credentials c where c.user_id = uid) >= 100 then
    raise exception 'too many saved' using errcode = '54000';
  end if;
  sid := vault.create_secret(p_sealed, null, 'studio credential');
  insert into public.credentials (user_id, kind, label, origin, username, card_brand, card_last4, card_exp, card_code_saved, secret_id, last_used_at)
  values (uid, p_kind, p_label, p_origin, p_username, p_card_brand, p_card_last4, p_card_exp,
          p_kind = 'card' and coalesce(p_card_code_saved, false), sid, now())
  returning id into cid;
  return cid;
end;
$$;
revoke execute on function public.save_credential(text, text, text, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.save_credential(text, text, text, text, text, text, text, text, boolean) to authenticated;
