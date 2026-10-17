-- Where the owner is in setting up this agent (the setup interview a template ships): whether
-- it's under way, done, or skipped, which conversation holds it, and its checklist as the agent
-- last reported it. Covered by the existing workspace_settings policies: members read it,
-- only owners change it. It's a hint for the UI, never a permission.
alter table public.workspace_settings
  add column setup jsonb check (setup is null or (jsonb_typeof(setup) = 'object' and pg_column_size(setup) <= 16384));

grant update (setup) on table public.workspace_settings to authenticated;
