-- A try: a chat started from the Try pane on the agent's page in Studio. It's an ordinary
-- conversation, run the ordinary way, kept apart in the sidebar and out of Home's recents and
-- routing so experiments don't crowd real work. Set when it's created, and never changed.

alter table public.conversations add column is_try boolean not null default false;
