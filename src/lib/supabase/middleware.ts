// Shared by src/middleware.ts — refreshes the Supabase session cookie on
// every request, and redirects unauthenticated users away from protected
// routes. Must run on every dynamic request or the session will silently
// expire mid-navigation.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getRole, canAccess, defaultHome } from "@/lib/auth/roles";

/** Paths exempt from auth — everything else requires a valid session. */
const PUBLIC_PATHS = new Set<string>(["/login", "/signup"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Supabase OAuth / magic-link callbacks (future) also land under /auth.
  if (pathname.startsWith("/auth/")) return true;
  // Vercel cron jobs authenticate via Bearer $CRON_SECRET, not Supabase Auth.
  if (pathname.startsWith("/api/cron/")) return true;
  // Same pattern for Solvpath sync endpoint (cron-secret auth, not session).
  if (pathname.startsWith("/api/sync/solvpath")) return true;
  if (pathname.startsWith("/api/sync/paysight")) return true;
  if (pathname.startsWith("/api/sync/chargeblast")) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  // Remote MCP server authenticates via Bearer token in the route, not Supabase.
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return true;
  // OAuth discovery metadata for the MCP connector (Claude.ai's "Connect" flow
  // probes these before it will use the token). Must return JSON, never a
  // redirect to /login — otherwise discovery fails and the connector hangs.
  if (pathname.startsWith("/.well-known/")) return true;
  return false;
}

export async function updateSession(request: NextRequest) {
  // Dev-only test bypass: requests carrying x-test-user-id + x-test-secret
  // matching CFO_TEST_BYPASS_SECRET skip the cookie-based auth check so
  // test scripts can drive the API without a browser session. Production
  // never enters this branch (both NODE_ENV and the secret must match).
  if (process.env.NODE_ENV !== "production") {
    const testUser = request.headers.get("x-test-user-id");
    const testSecret = request.headers.get("x-test-secret");
    const expected = process.env.CFO_TEST_BYPASS_SECRET;
    if (testUser && testSecret && expected && testSecret === expected) {
      return NextResponse.next({ request });
    }
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Touching getUser() is what refreshes the session cookie. Do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Unauthenticated + protected → redirect to /login with ?next= return path.
  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Authenticated + on /login or /signup → bounce to ?next= or default home.
  if (user && (pathname === "/login" || pathname === "/signup")) {
    const role = getRole(user.email);
    const next = request.nextUrl.searchParams.get("next") || defaultHome(role);
    const target = canAccess(role, next) ? next : defaultHome(role);
    const url = request.nextUrl.clone();
    url.pathname = target.startsWith("/") ? target : "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Role-based access: managers only get /cogs. Redirect elsewhere.
  if (user) {
    const role = getRole(user.email);
    if (!canAccess(role, pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = defaultHome(role);
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}
