import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/supabase/db";
import { continueClaimedTask, runClaimedTask } from "@/lib/tasks/run-task";
import { jsonError, resolveTenant, sessionFor } from "@/lib/tenant";

// Starts a run the scheduler already queued, for the background worker (trigger/run-task.ts).
// The worker signs in as the task's member and sends that session's access token; this is the
// only route that takes one in a header, and all it can do is start one of that member's own
// queued runs, or carry on one of theirs that ran out of time with more to do. The run then happens here, with the app's own settings and keys, exactly like
// "Run now": as the member, under RLS. Answers with how the run ended.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return jsonError(401, "Not signed in.");
  const { id, runId } = await params;
  const ids = z.object({ id: z.uuid(), runId: z.uuid() }).safeParse({ id, runId });
  const workspace = z.uuid().safeParse(request.nextUrl.searchParams.get("workspace"));
  if (!ids.success || !workspace.success) return jsonError(404, "Run not found.");

  // The token is checked with Supabase Auth, and the client acts as that member: anon key
  // plus their own token, so Row Level Security applies to everything below.
  const { supabase } = getConfig();
  const db = createClient(supabase.url, supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  }) as unknown as Db;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return jsonError(401, "Not signed in.");

  // The run's workspace, honored only if they're still a member of it.
  const tenant = await resolveTenant(sessionFor(db, data.user), workspace.data);
  if (!tenant || tenant.workspace.id !== workspace.data) return jsonError(404, "Run not found.");

  try {
    // ?continue=1: carry on a run whose latest reply ran out of time with more to do.
    const claimed = { taskId: ids.data.id, runId: ids.data.runId };
    const outcome = request.nextUrl.searchParams.get("continue") === "1" ? await continueClaimedTask(tenant, claimed) : await runClaimedTask(tenant, claimed);
    return NextResponse.json(outcome);
  } catch (e) {
    return errorResponse(e);
  }
}
