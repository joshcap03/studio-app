import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient, type Db } from "@/lib/supabase/server";
import type { WorkspaceSummary } from "@/lib/types";

// Identity and tenancy are derived only from the authenticated session. The active
// workspace is a preference cookie, honored only if the user is actually a member of it
// (checked against the database under RLS); request bodies and URLs never choose it.

export const ACTIVE_WORKSPACE_COOKIE = "lj_ws";

export interface Session {
  db: Db;
  userId: string;
  email: string | null;
}

export interface Tenant extends Session {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  /** This member's private id for tool connections (Composio user id). */
  composioUserId: string;
}

export async function getSession(): Promise<Session | null> {
  const db = await createSupabaseServerClient();
  // getUser() validates the token with Supabase Auth instead of trusting the cookie.
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return { db, userId: data.user.id, email: data.user.email ?? null };
}

interface MembershipRow {
  workspace_id: string;
  role: "owner" | "member";
  composio_user_id: string;
  created_at: string;
  workspaces: { name: string } | null;
}

export async function resolveTenant(session: Session, preferred?: string | null): Promise<Tenant | null> {
  const { data, error } = await session.db
    .from("workspace_members")
    .select("workspace_id, role, composio_user_id, created_at, workspaces(name)")
    .eq("user_id", session.userId)
    .order("created_at", { ascending: true })
    .returns<MembershipRow[]>();
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const workspaces: WorkspaceSummary[] = data.map((m) => ({
    id: m.workspace_id,
    name: m.workspaces?.name ?? "Workspace",
    role: m.role,
  }));
  const active = data.find((m) => m.workspace_id === preferred) ?? data[0];
  return {
    ...session,
    workspaces,
    workspace: workspaces.find((w) => w.id === active.workspace_id)!,
    composioUserId: active.composio_user_id,
  };
}

/** For server components: signed out → /login, no workspace yet → onboarding. */
export async function requirePageTenant(): Promise<Tenant> {
  const session = await getSession();
  if (!session) redirect("/login");
  const preferred = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const tenant = await resolveTenant(session, preferred);
  if (!tenant) redirect("/onboarding");
  return tenant;
}

export function jsonError(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

type Authorized<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** Authenticates an API request and rejects cross-origin writes. */
export async function authorizeSession(request: NextRequest): Promise<Authorized<Session>> {
  if (!isReadOnly(request) && !isSameOrigin(request)) {
    return { ok: false, response: jsonError(403, "Cross-origin request refused.") };
  }
  const session = await getSession();
  if (!session) return { ok: false, response: jsonError(401, "Not signed in.") };
  return { ok: true, value: session };
}

/** Authenticates an API request and resolves the caller's active workspace. */
export async function authorizeTenant(request: NextRequest): Promise<Authorized<Tenant>> {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth;
  const tenant = await resolveTenant(auth.value, request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value);
  if (!tenant) return { ok: false, response: jsonError(409, "Create a workspace first.", "no_workspace") };
  return { ok: true, value: tenant };
}

function isReadOnly(request: NextRequest): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function isSameOrigin(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return fetchSite === "same-origin";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
