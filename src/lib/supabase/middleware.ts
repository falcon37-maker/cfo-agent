// Shared by src/middleware.ts — refreshes the Supabase session cookie on
// every request, and redirects unauthenticated users away from protected
// routes. Must run on every dynamic request or the session will silently
// expire mid-navigation.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getRole, canAccess, defaultHome } from "@/lib/auth/roles";

/** Paths exempt from auth — everything else requires a valid session. */
const PUBLIC_PATHS = new Set<string>(["/login"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Supabase OAuth / magic-link callbacks (future) also land under /auth.
  if (pathname.startsWith("/auth/")) return true;
  // Vercel cron jobs authenticate via Bearer $CRON_SECRET, not Supabase Auth.
  if (pathname.startsWith("/api/cron/")) return true;
  // Same pattern for Solvpath sync endpoint (cron-secret auth, not session).
  if (pathname.startsWith("/api/sync/solvpath")) return true;
  if (pathname.startsWith("/api/sync/chargeblast")) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  return false;
}

export async function updateSession(request: NextRequest) {
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

  // Authenticated + on /login → bounce to ?next= or role's default home.
  if (user && pathname === "/login") {
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
