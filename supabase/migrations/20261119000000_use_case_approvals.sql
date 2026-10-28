-- Approvals ask once per use case.
--
-- The agent now asks only before it moves money or deletes something for good
-- (langflow/components/tool_gateway.py `needs_approval`), and the member's first approval of a
-- kind OKs it for good, so each use case asks once. A kind is no longer only 'gmail_labels': it's
-- one app tool ('tool:STRIPE_CREATE_REFUND') or paying on one website in the agent's browser
-- ('site:usps.com', the host read from the browser itself). src/lib/approvals/standing.ts decides
-- the kind from what approving would run, never from the agent's words.
--
-- The column checks move from a fixed list to that shape, checked by one function. Additive in
-- effect: every value the old checks allowed still passes.

create or replace function public.is_standing_kind(kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select kind is not null and length(kind) <= 260 and (
    kind = 'gmail_labels'
    or kind ~ '^tool:[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$'
    or kind ~ '^site:[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  );
$$;

create or replace function public.are_standing_kinds(kinds text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_length(kinds, 1), 0) <= 500
    and coalesce((select bool_and(public.is_standing_kind(k)) from unnest(kinds) as k), true);
$$;

alter table public.approvals drop constraint if exists approvals_standing_check;
alter table public.approvals
  add constraint approvals_standing_check check (standing is null or public.is_standing_kind(standing));

alter table public.agent_tasks drop constraint if exists agent_tasks_allowed_actions_check;
alter table public.agent_tasks
  add constraint agent_tasks_allowed_actions_check check (public.are_standing_kinds(allowed_actions));

alter table public.accounts drop constraint if exists accounts_allowed_actions_check;
alter table public.accounts
  add constraint accounts_allowed_actions_check check (public.are_standing_kinds(allowed_actions));
