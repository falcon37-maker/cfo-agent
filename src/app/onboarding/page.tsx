import Link from "next/link";
import { redirect } from "next/navigation";
import { LineChart, Building2, ArrowRight } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { completeOnboardingAction } from "./actions";

export const dynamic = "force-dynamic";

const ERR_MAP: Record<string, string> = {
  name: "Tell us what to call your business.",
  db: "Couldn't save — try again.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const ssr = await createSupabaseServerClient();
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user) redirect("/login");

  // Pull the tenant row directly off the service-role client — phase 1A's
  // trigger would have provisioned it on signup. If the trigger somehow
  // didn't fire (existing user logging in), the row gets created lazily
  // below.
  const sb = supabaseAdmin();
  const { data: tenant } = await sb
    .from("tenants")
    .select("display_name, email")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!tenant) {
    // Fallback: provision via RPC. Should be unreachable post-trigger.
    await sb.rpc("ensure_owner_tenant", {
      p_user_id: user.id,
      p_email: user.email ?? "",
      p_display: null,
    });
  }

  const params = await searchParams;
  const errMessage = ERR_MAP[params.err ?? ""] ?? null;
  const initialName =
    tenant?.display_name && tenant.display_name !== (user.email?.split("@")[0] ?? "")
      ? tenant.display_name
      : "";
  const year = new Date().getFullYear();

  return (
    <div className="auth-shell">
      <aside className="auth-left">
        <div className="auth-left-inner">
          <div className="auth-brand">
            <div
              className="logo-mark"
              style={{ width: 36, height: 36, borderRadius: 10 }}
            >
              <LineChart size={20} strokeWidth={2.5} />
            </div>
            <div>
              <div className="auth-brand-name">CFO Agent</div>
              <div className="auth-brand-sub">Finance OS</div>
            </div>
          </div>

          <div className="auth-quote">
            <div className="auth-live">
              <span />
              Almost there
            </div>
            <h2 className="auth-head">
              One detail
              <br />
              and you&apos;re{" "}
              <span className="mono" style={{ color: "var(--accent)" }}>
                live
              </span>
            </h2>
          </div>

          <div className="auth-foot">© {year} CFO Agent</div>
        </div>
      </aside>

      <main className="auth-right">
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="eyebrow">Welcome</div>
            <h1 className="auth-title">What&apos;s your business?</h1>
            <div className="auth-card-sub">
              Used as the workspace name. You can change it later in
              Settings.
            </div>
          </div>

          <form action={completeOnboardingAction} className="auth-form" noValidate>
            <label className="field">
              <span className="field-label">Business name</span>
              <div className="field-input">
                <Building2 size={14} strokeWidth={2} />
                <input
                  type="text"
                  name="display_name"
                  autoFocus
                  required
                  defaultValue={initialName}
                  placeholder="Acme LLC"
                  maxLength={120}
                />
              </div>
            </label>

            {errMessage ? <div className="auth-err">{errMessage}</div> : null}

            <button type="submit" className="primary-btn auth-submit">
              Open dashboard
              <ArrowRight size={13} strokeWidth={2.3} />
            </button>
          </form>

          <div className="auth-card-foot">
            <Link href="/" style={{ color: "var(--muted)" }}>
              Skip for now →
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
