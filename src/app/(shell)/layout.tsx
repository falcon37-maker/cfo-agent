import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function ShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Middleware guarantees a user exists on every (shell) route, but we fetch
  // here so the sidebar can display the user email + a working logout.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="app">
      <Sidebar
        userEmail={user?.email ?? null}
        userId={user?.id ?? null}
      />
      <div className="main">
        <TopBar />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
