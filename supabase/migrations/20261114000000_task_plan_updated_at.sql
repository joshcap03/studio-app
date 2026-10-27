-- When a task's plan last changed, apart from the task's other edits.
--
-- The rail over a task's conversation shows the plan while it's the work in front of the member:
-- once they've written since it last changed and the reply leaves it as it was, it goes. A task's
-- updated_at also moves when it runs or its schedule changes, which would bring back a plan
-- nobody touched. Additive only: the running code never reads this column, and a task without it
-- falls back on updated_at.
alter table public.agent_tasks
  add column plan_updated_at timestamptz;
grant update (plan_updated_at) on table public.agent_tasks to authenticated;
