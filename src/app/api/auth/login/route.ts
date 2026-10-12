import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSameOrigin, jsonError } from "@/lib/auth/server";
import {
  OWNER_USER_ID,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  passwordMatches,
} from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getStore } from "@/lib/db/store";

const body = z.object({ password: z.string().min(1).max(500) });

// Simple in-memory throttle: 10 failed attempts per address per 15 minutes.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; since: number }>();

/** HTTPS directly or behind a proxy, and any production request not on loopback. */
function isSecureContext(request: NextRequest): boolean {
  if (request.nextUrl.protocol === "https:") return true;
  if (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(request.nextUrl.hostname);
  return process.env.NODE_ENV === "production" && !loopback;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request refused.");

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const record = failures.get(ip);
  if (record && Date.now() - record.since < WINDOW_MS && record.count >= MAX_FAILURES) {
    return jsonError(429, "Too many attempts. Try again in a few minutes.");
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Enter your password.");

  const config = getConfig();
  if (!(await passwordMatches(parsed.data.password, config.appPassword))) {
    const fresh = !record || Date.now() - record.since >= WINDOW_MS;
    failures.set(ip, { count: fresh ? 1 : record.count + 1, since: fresh ? Date.now() : record.since });
    return jsonError(401, "That password isn't right.");
  }
  failures.delete(ip);

  getStore().ensureUser(OWNER_USER_ID);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(OWNER_USER_ID, config.sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureContext(request),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
