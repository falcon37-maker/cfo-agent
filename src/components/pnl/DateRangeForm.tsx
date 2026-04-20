import { ReactNode } from "react";

/**
 * GET form with two date inputs. Submits to `action` with `from` and `to`
 * query params plus any hidden fields passed via `hidden`. Server-rendered —
 * no client JS required.
 */
export function DateRangeForm({
  action,
  from,
  to,
  hidden = {},
}: {
  action: string;
  from?: string;
  to?: string;
  hidden?: Record<string, string>;
}): ReactNode {
  return (
    <form
      method="get"
      action={action}
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
      }}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input
        type="date"
        name="from"
        defaultValue={from ?? ""}
        aria-label="From"
        style={dateInputStyle}
      />
      <span style={{ color: "var(--muted)", fontSize: 11 }}>→</span>
      <input
        type="date"
        name="to"
        defaultValue={to ?? ""}
        aria-label="To"
        style={dateInputStyle}
      />
      <button type="submit" className="ghost-btn" style={{ padding: "5px 10px" }}>
        Apply
      </button>
    </form>
  );
}

const dateInputStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "5px 8px",
  colorScheme: "dark",
};
