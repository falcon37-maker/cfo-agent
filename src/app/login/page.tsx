import { LineChart } from "lucide-react";
import { LoginForm } from "@/components/login/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; next?: string }>;
}) {
  const params = await searchParams;
  const errMessage =
    params.err === "bad"
      ? "Incorrect email or password."
      : params.err === "missing"
        ? "Enter your email and password to continue."
        : null;
  const nextPath = params.next?.startsWith("/") ? params.next : "/";
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
              Agent is watching
            </div>
            <h2 className="auth-head">
              Your AI CFO,
              <br />
              on the clock{" "}
              <span className="mono" style={{ color: "var(--accent)" }}>
                24/7
              </span>
            </h2>
          </div>

          <div className="auth-foot">© {year} CFO Agent · Falcon 37 LLC</div>
        </div>
      </aside>

      <main className="auth-right">
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="eyebrow">Welcome back</div>
            <h1 className="auth-title">Sign in to your workspace</h1>
            <div className="auth-card-sub">
              Use your work email. We&apos;ll sync your stores after sign-in.
            </div>
          </div>

          <LoginForm nextPath={nextPath} errMessage={errMessage} />

          <div className="auth-card-foot">
            Don&apos;t have an account?{" "}
            <a href="mailto:joe@falcon37.com?subject=CFO%20Agent%20access%20request">
              Request access
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
