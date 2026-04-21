export function fmtMoney(amount: number | string | null | undefined, currency = "USD"): string {
  const n = typeof amount === "string" ? Number(amount) : (amount ?? 0);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtPct(value: number | string | null | undefined, digits = 1): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function fmtInt(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

/**
 * Parse a human-typed money/number string into a clean 2-decimal number.
 * Accepts anything you'd paste from Ads Manager / a spreadsheet:
 *   "$1,234.56"    → 1234.56
 *   "1,234.567"    → 1234.57
 *   " $12.0 "      → 12
 *   "(50.00)"      → -50      (accounting-style parens)
 *   "abc 99.99 xx" → 99.99
 *   ""             → 0
 * Returns 0 for any unparseable input.
 */
export function parseLooseNumber(raw: string): number {
  if (!raw) return 0;
  const trimmed = String(raw).trim();
  if (!trimmed) return 0;

  // Accounting-style negatives: (123.45) → -123.45
  const parenNeg = /^\(.*\)$/.test(trimmed);
  let s = trimmed.replace(/[()]/g, "");

  // Keep digits, minus, dot; drop everything else.
  s = s.replace(/[^\d.\-]/g, "");

  // Collapse to at most one leading "-" at position 0.
  const isNeg = parenNeg || s.startsWith("-");
  s = s.replace(/-/g, "");

  // If multiple dots, keep only the first.
  const firstDot = s.indexOf(".");
  if (firstDot >= 0) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  if (!s || s === ".") return 0;

  const n = Number(s) * (isNeg ? -1 : 1);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Nicely format the cleaned number back for re-display in an input. */
export function formatAmountInput(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toFixed(2);
}

export function fmtDate(iso: string): string {
  // iso is YYYY-MM-DD — render as e.g. "Apr 18"
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(dt);
}
