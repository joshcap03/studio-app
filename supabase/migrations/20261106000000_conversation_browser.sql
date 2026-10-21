-- The agent's browser for one conversation, so its member can watch it (view only) on a call.
-- Studio Browser opens one hosted browser per conversation; the turn records its session id here,
-- sealed with a MAC the app makes with its own Browserbase key (src/lib/browser-view.ts), because
-- the member can write this column: an id they wrote themselves fails the check, so the app never
-- looks at a browser that isn't this conversation's. Never sent to the page; nothing else about
-- the browser (its connection URL) is ever stored. Additive: the running code never reads it.
alter table public.conversations
  add column browser_session text check (browser_session is null or char_length(browser_session) between 1 and 300);

grant update (browser_session) on table public.conversations to authenticated;
