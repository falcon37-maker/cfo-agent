// Per-request Supabase client for Server Components, Server Actions, and
// Route Handlers. Backed by cookies so the user's session travels with every
// request without needing explicit headers.
//
// This is distinct from `src/lib/supabase/admin.ts`, which uses the service
// role and bypasses RLS — keep that one for background jobs and data syncs.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a read-only context (plain Server Component).
            // Middleware still refreshes the cookie, so this is non-fatal.
          }
        },
      },
    },
  );
}
