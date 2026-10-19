-- Keeps Langflow's Postgres small. Langflow caps transactions and vertex builds itself but
-- never prunes background jobs, their event logs, or its native traces, and a full database
-- (Neon's free plan stops writes at 1 GB) fails every run. Run daily (`prune.sh`).
-- Only finished runs go: a run paused for an approval is 'suspended' and keeps everything.

-- Event logs and checkpoints only serve a run in flight or a client reconnecting to it.
delete from job_events e using job j
 where j.job_id = e.job_id
   and j.status in ('completed', 'failed', 'cancelled', 'timed_out')
   and coalesce(j.finished_timestamp, j.created_timestamp) < now() - interval '1 day';

delete from job_checkpoints c using job j
 where j.job_id = c.job_id
   and j.status in ('completed', 'failed', 'cancelled', 'timed_out')
   and coalesce(j.finished_timestamp, j.created_timestamp) < now() - interval '1 day';

delete from job
 where status in ('completed', 'failed', 'cancelled', 'timed_out')
   and coalesce(finished_timestamp, created_timestamp) < now() - interval '14 days';

-- Native traces are off (Dockerfile); this bounds them if they're ever turned back on.
-- Spans go with their trace.
delete from trace where start_time < now() - interval '3 days';

-- Free the space for reuse so the tables stop growing.
vacuum job_events, job_checkpoints, job, span, trace;
