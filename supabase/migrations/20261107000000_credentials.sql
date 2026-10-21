-- Saved logins and cards, so the agent's browser can sign in and pay without anyone typing them
-- into chat. They belong to the person (like connected apps), so every one of their agents can
-- use them, and only through the secure fill card: the app types them into the browser over its
-- own connection (src/lib/browser-fill.ts), and the agent never sees them.
--
-- What's secret (a password; a card's number, name, and expiry) is sealed twice: the app encrypts
-- it with its own key, bound to the person (src/lib/secrets), and Supabase Vault encrypts that at
-- rest. A session alone can read back only the app's ciphertext. A card's security code is never
-- stored. What's shown to the member to pick from (a label, the site, the username, the card's
-- brand, last four, and expiry) is kept in the clear.

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('login', 'card')),
  label text not null check (char_length(label) between 1 and 80),
  -- A login's site: exactly the https origin it was saved for, and filled only there.
  origin text check (origin is null or origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'),
  username text check (username is null or char_length(username) <= 200),
  card_brand text check (card_brand is null or char_length(card_brand) <= 20),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp text check (card_exp is null or card_exp ~ '^(0[1-9]|1[0-2])/[0-9]{2}$'),
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  check (
    (kind = 'login' and origin is not null and card_last4 is null)
    or (kind = 'card' and origin is null and username is null and card_last4 is not null and card_exp is not null)
  )
);

create unique index credentials_login on public.credentials (user_id, origin, coalesce(username, '')) where kind = 'login';
create index credentials_user on public.credentials (user_id, kind, last_used_at desc nulls last);

alter table public.credentials enable row level security;

-- Only the person themself, and only what's shown. Saving, revealing, and removing go through
-- the functions below, which keep the Vault secret in step with the row.
create policy "read own credentials" on public.credentials
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.credentials from anon, authenticated;
grant select (id, user_id, kind, label, origin, username, card_brand, card_last4, card_exp, created_at, last_used_at)
  on table public.credentials to authenticated;

-- Saves one of the caller's logins or cards, replacing a login already saved for the same site
-- and username. `p_sealed` is the app's ciphertext. Returns the row's id.
create function public.save_credential(
  p_kind text,
  p_label text,
  p_sealed text,
  p_origin text default null,
  p_username text default null,
  p_card_brand text default null,
  p_card_last4 text default null,
  p_card_exp text default null
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
  end if;
  if existing.id is not null then
    perform vault.update_secret(existing.secret_id, p_sealed);
    update public.credentials set label = p_label, last_used_at = now() where id = existing.id;
    return existing.id;
  end if;
  if (select count(*) from public.credentials c where c.user_id = uid) >= 100 then
    raise exception 'too many saved' using errcode = '54000';
  end if;
  sid := vault.create_secret(p_sealed, null, 'studio credential');
  insert into public.credentials (user_id, kind, label, origin, username, card_brand, card_last4, card_exp, secret_id, last_used_at)
  values (uid, p_kind, p_label, p_origin, p_username, p_card_brand, p_card_last4, p_card_exp, sid, now())
  returning id into cid;
  return cid;
end;
$$;

-- The app's ciphertext for one of the caller's own credentials (null for anyone else's), marked used.
create function public.reveal_credential(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  sid uuid;
  sealed text;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.credentials set last_used_at = now() where id = p_id and user_id = uid returning secret_id into sid;
  if sid is null then
    return null;
  end if;
  select s.decrypted_secret into sealed from vault.decrypted_secrets s where s.id = sid;
  return sealed;
end;
$$;

-- Removes one of the caller's own credentials (its secret goes with it, below). Whether there was one.
create function public.delete_credential(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  removed uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from public.credentials where id = p_id and user_id = uid returning id into removed;
  return removed is not null;
end;
$$;

-- A credential's Vault secret goes whenever the row does: removed by its owner, or with their account.
create function public.forget_credential_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

revoke execute on function public.forget_credential_secret() from public, anon, authenticated;

create trigger credentials_forget_secret after delete on public.credentials
  for each row execute function public.forget_credential_secret();

revoke execute on function public.save_credential(text, text, text, text, text, text, text, text) from public, anon;
revoke execute on function public.reveal_credential(uuid) from public, anon;
revoke execute on function public.delete_credential(uuid) from public, anon;
grant execute on function public.save_credential(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.reveal_credential(uuid) to authenticated;
grant execute on function public.delete_credential(uuid) to authenticated;
