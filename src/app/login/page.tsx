import { signInAction } from "./actions";

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
        ? "Email and password are required."
        : null;

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="logo-mark" style={{ width: 40, height: 40 }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>CA</span>
          </div>
          <div>
            <div className="login-title">CFO Agent</div>
            <div className="login-sub">Falcon 37 · Finance OS</div>
          </div>
        </div>

        <form action={signInAction} className="login-form">
          <input type="hidden" name="next" value={params.next ?? "/"} />

          <label className="login-field">
            <span className="login-label">Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              autoFocus
              placeholder="you@falcon37.com"
            />
          </label>

          <label className="login-field">
            <span className="login-label">Password</span>
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </label>

          {errMessage ? <div className="login-error">{errMessage}</div> : null}

          <button type="submit" className="login-submit">
            Sign in
          </button>
        </form>

        <div className="login-foot">
          New users are provisioned by Joe via the Supabase dashboard.
        </div>
      </div>
    </main>
  );
}
