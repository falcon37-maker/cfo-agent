import Link from "next/link";
import { LineChart } from "lucide-react";
import { SignupForm } from "@/components/login/SignupForm";

export const dynamic = "force-dynamic";

const ERR_MAP: Record<string, string> = {
  missing: "Enter your email and password.",
  short: "Password must be at least 8 characters.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const params = await searchParams;
  const errKey = params.err ?? "";
  const errMessage = ERR_MAP[errKey] ?? (errKey ? decodeURIComponent(errKey) : null);
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
              Your financial cockpit
            </div>
            <h2 className="auth-head">
              One dashboard for the
              <br />
              numbers that{" "}
              <span className="mono" style={{ color: "var(--accent)" }}>
                matter
              </span>
            </h2>
          </div>

          <div className="auth-foot">© {year} CFO Agent</div>
        </div>
      </aside>

      <main className="auth-right">
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="eyebrow">Create your workspace</div>
            <h1 className="auth-title">Start for free</h1>
            <div className="auth-card-sub">
              Sign up with email and password. We&apos;ll get you to a
              dashboard in 30 seconds.
            </div>
          </div>

          <SignupForm errMessage={errMessage} />

          <div className="auth-card-foot">
            Already have an account?{" "}
            <Link href="/login" style={{ color: "var(--accent)" }}>
              Sign in
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
