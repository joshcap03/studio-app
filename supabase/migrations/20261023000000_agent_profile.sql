-- Workspaces are no longer assumed to be businesses. `business_context` keeps its physical
-- name (the app calls it the agent profile: what this agent is for), so code serving during a
-- deploy keeps working. `template_id` records which built-in template the workspace started
-- from or last applied (src/lib/templates); it's a hint for the UI, never a permission.

alter table public.workspace_settings
  add column template_id text check (template_id is null or char_length(template_id) between 1 and 40);

grant update (template_id) on table public.workspace_settings to authenticated;

comment on column public.workspace_settings.business_context is
  'The agent profile: who the agent works for and what it is for. Shown as "What this agent is for".';
