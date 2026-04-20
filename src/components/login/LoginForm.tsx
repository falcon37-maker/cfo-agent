"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight, Grid3x3 } from "lucide-react";
import { signInAction } from "@/app/login/actions";

export function LoginForm({
  nextPath,
  errMessage,
}: {
  nextPath: string;
  errMessage: string | null;
}) {
  const [show, setShow] = useState(false);

  return (
    <form action={signInAction} className="auth-form" noValidate>
      <input type="hidden" name="next" value={nextPath} />

      <label className="field">
        <span className="field-label">Email</span>
        <div className="field-input">
          <Mail size={14} strokeWidth={2} />
          <input
            type="email"
            name="email"
            autoComplete="email"
            autoFocus
            required
            placeholder="you@falcon37.com"
          />
        </div>
      </label>

      <label className="field">
        <span className="field-label">
          Password
          <a href="#" className="field-aside" onClick={(e) => e.preventDefault()}>
            Forgot?
          </a>
        </span>
        <div className="field-input">
          <Lock size={14} strokeWidth={2} />
          <input
            type={show ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            required
            placeholder="••••••••••"
          />
          <button
            type="button"
            className="eye-btn"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
          </button>
        </div>
      </label>

      <div className="auth-row-between">
        <label className="check">
          <input type="checkbox" defaultChecked />
          <span className="check-box" />
          <span>Keep me signed in</span>
        </label>
      </div>

      {errMessage ? <div className="auth-err">{errMessage}</div> : null}

      <SubmitButton />

      <div className="auth-divider">
        <span>or</span>
      </div>

      <button
        type="button"
        className="auth-sso"
        disabled
        title="SSO coming soon"
      >
        <Grid3x3 size={14} strokeWidth={2} />
        Continue with SSO
      </button>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="primary-btn auth-submit"
      disabled={pending}
    >
      {pending ? (
        <>
          <span className="spinner" /> Signing in…
        </>
      ) : (
        <>
          Sign in
          <ArrowRight size={13} strokeWidth={2.3} />
        </>
      )}
    </button>
  );
}
