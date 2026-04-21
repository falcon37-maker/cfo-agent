"use client";

import { useState } from "react";
import { parseLooseNumber, formatAmountInput } from "@/lib/format";

/**
 * Spreadsheet-grade dollar-amount input. Accepts `$1,234.567`, `(50)`,
 * whitespace, garbage characters — anything. Extracts the numeric value on
 * every keystroke (so the hidden form field is always accurate) and
 * reformats the visible text to `1234.57` on blur.
 *
 * The hidden input is what gets posted with the form — consumers read the
 * `name` prop and receive a clean decimal string (`"1234.57"`) server-side.
 */
export function AmountInput({
  name,
  placeholder = "0.00",
  required = true,
  onValueChange,
}: {
  name: string;
  placeholder?: string;
  required?: boolean;
  onValueChange?: (n: number) => void;
}) {
  const [display, setDisplay] = useState("");
  const parsed = parseLooseNumber(display);

  return (
    <div className="field-input field-amount">
      <span className="amount-prefix">$</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={display}
        onChange={(e) => {
          setDisplay(e.target.value);
          onValueChange?.(parseLooseNumber(e.target.value));
        }}
        onBlur={() => {
          // On blur, normalize the display to a clean 2-decimal form so the
          // user sees the value the server will receive.
          setDisplay(formatAmountInput(parsed));
        }}
        onFocus={(e) => e.target.select()}
        placeholder={placeholder}
      />
      <input type="hidden" name={name} value={parsed || ""} />
      {required ? (
        <input
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          required
          value={parsed > 0 ? "1" : ""}
          onChange={() => {}}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
}
