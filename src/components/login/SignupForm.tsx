"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import { signUpAction } from "@/app/login/actions";

export function SignupForm({ errMessage }: { errMessage: string | null }) {
  const [show, setShow] = useState(false);

  return (
    <form action={signUpAction} className="auth-form" noValidate>
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
            placeholder="you@yourcompany.com"
          />
        </div>
      </label>

      <label className="field">
        <span className="field-label">Password (8+ chars)</span>
        <div className="field-input">
          <Lock size={14} strokeWidth={2} />
          <input
            type={show ? "text" : "password"}
            name="password"
            autoComplete="new-password"
            required
            minLength={8}
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

      {errMessage ? <div className="auth-err">{errMessage}</div> : null}

      <SubmitButton />
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
          <span className="spinner" /> Creating account…
        </>
      ) : (
        <>
          Create account
          <ArrowRight size={13} strokeWidth={2.3} />
        </>
      )}
    </button>
  );
}
