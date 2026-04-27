"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, Save } from "lucide-react";

type SecretFieldProps = {
  name: string;
  label: string;
  /** True when the row already has an encrypted value saved. */
  hasSaved: boolean;
};

/** Password input that supports the empty-string-keeps-existing convention
 *  the server actions implement. Magic value "CLEAR" wipes the field. */
export function SecretField({ name, label, hasSaved }: SecretFieldProps) {
  const [show, setShow] = useState(false);
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hasSaved ? (
          <span className="field-aside" style={{ color: "var(--accent)" }}>
            saved · type CLEAR to remove
          </span>
        ) : null}
      </span>
      <div className="field-input">
        <input
          type={show ? "text" : "password"}
          name={name}
          placeholder={hasSaved ? "•••••••• (leave empty to keep)" : ""}
          autoComplete="off"
        />
        <button
          type="button"
          className="eye-btn"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}

export function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="primary-btn"
      disabled={pending}
      style={{ alignSelf: "flex-start" }}
    >
      {pending ? <span className="spinner" /> : <Save size={13} strokeWidth={2} />}
      {pending ? "Saving…" : "Save"}
    </button>
  );
}
