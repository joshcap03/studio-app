import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request and keeps signed-out traffic away from
// the app. Route handlers and pages verify the user again; this is the outer gate.

const PUBLIC_PATHS = ["/login", "/auth/confirm", "/api/auth/"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (data.user || PUBLIC_PATHS.some((p) => path.startsWith(p)) || isWorkerRunStart(request) || isVoiceFront(request) || isWatchEvent(request)) return response;

  if (path.startsWith("/api/")) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const login = new URL("/login", request.url);
  const next = path + request.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

// The background worker starting a queued task run, or carrying on a chat reply's job, carries the
// member's access token instead of a cookie. Only those two routes take a token, and they verify it
// with Supabase Auth themselves (authorizeWorker in src/lib/tenant.ts); nothing else gets past
// without a session.
const WORKER_ROUTES = [/^\/api\/tasks\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/i, /^\/api\/conversations\/[0-9a-f-]{36}\/keep-going$/i];

function isWorkerRunStart(request: NextRequest): boolean {
  return (
    request.method === "POST" &&
    WORKER_ROUTES.some((route) => route.test(request.nextUrl.pathname)) &&
    /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")
  );
}

// The voice provider calling the voice front for a call's next line carries its custom-LLM key
// instead of a cookie. The route checks that key and the call's sealed context itself
// (src/app/api/voice/llm/v1/chat/completions/route.ts) and reads no member data.
const VOICE_FRONT = "/api/voice/llm/v1/chat/completions";

function isVoiceFront(request: NextRequest): boolean {
  return request.method === "POST" && request.nextUrl.pathname === VOICE_FRONT && /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");
}

// Composio delivering a watch's event carries its own signature instead of a cookie. The route
// verifies it (src/app/api/watches/composio/route.ts), reads no member data, and only hands the
// event to the background worker.
const WATCH_EVENTS = "/api/watches/composio";

function isWatchEvent(request: NextRequest): boolean {
  return request.method === "POST" && request.nextUrl.pathname === WATCH_EVENTS && Boolean(request.headers.get("webhook-signature"));
}

export const config = {
  // The app manifest, service worker, and home-screen icons load without a session (iOS
  // fetches the manifest without cookies).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|apple-icon.png).*)",
  ],
};
