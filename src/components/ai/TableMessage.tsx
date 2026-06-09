"use client";

// Renders a structured table inside a chat bubble. Used when /api/chat
// returns mode:"table" — the backend skipped the main LLM because the
// dataset was too large to inline.
//
// Features:
//   - Column-aware formatting (money / pct / date / int / text)
//   - Right-aligned numerics, left-aligned text
//   - Sticky header with horizontal + vertical scroll
//   - Footer with row count + CSV export
//   - Compact styling that fits the existing chat bubble width
//
// No sorting / filtering yet — Phase A keeps it simple. We can layer those
// in once the basic experience is stable.

import { Download } from "lucide-react";

export type TableColumn = {
  key: string;
  label: string;
  format?: "money" | "pct" | "date" | "int" | "text";
};

export type TableData = {
  query_id: string;
  category: string;
  rows: Record<string, unknown>[];
  columns: TableColumn[];
  summary: string;
};

type Props = {
  table: TableData;
};

export function TableMessage({ table }: Props) {
  const { rows, columns, summary } = table;

  function downloadCsv() {
    const header = columns.map((c) => csvEscape(c.label)).join(",");
    const body = rows
      .map((r) =>
        columns
          .map((c) => csvEscape(String(r[c.key] ?? "")))
          .join(","),
      )
      .join("\n");
    const blob = new Blob([`${header}\n${body}\n`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${table.category}-${table.query_id}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="cfo-table-wrap">
      <div className="cfo-table-summary">{summary}</div>
      <div className="cfo-table-scroll">
        <table className="cfo-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`cfo-th cfo-th-${alignFor(c.format)}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`cfo-td cfo-td-${alignFor(c.format)}`}
                  >
                    {formatCell(row[c.key], c.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cfo-table-footer">
        <span>{rows.length} rows</span>
        <button
          type="button"
          className="cfo-table-export"
          onClick={downloadCsv}
          aria-label="Export as CSV"
        >
          <Download size={12} />
          <span>Export CSV</span>
        </button>
      </div>

      <style jsx>{`
        .cfo-table-wrap {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          overflow: hidden;
          margin-top: 4px;
        }
        .cfo-table-summary {
          padding: 10px 14px;
          font-size: 12px;
          color: var(--text-dim);
          border-bottom: 1px solid var(--border);
          background: var(--surface-2);
        }
        .cfo-table-scroll {
          max-height: 360px;
          overflow: auto;
        }
        .cfo-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12.5px;
          font-variant-numeric: tabular-nums;
        }
        .cfo-th {
          position: sticky;
          top: 0;
          background: var(--surface-3);
          color: var(--text);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          padding: 9px 12px;
          border-bottom: 1px solid var(--border-strong);
          white-space: nowrap;
        }
        .cfo-td {
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          color: var(--text);
          white-space: nowrap;
        }
        tbody tr:last-child .cfo-td {
          border-bottom: none;
        }
        tbody tr:hover .cfo-td {
          background: var(--surface-2);
        }
        .cfo-th-right,
        .cfo-td-right {
          text-align: right;
        }
        .cfo-th-left,
        .cfo-td-left {
          text-align: left;
        }
        .cfo-table-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          font-size: 11.5px;
          color: var(--muted);
          background: var(--surface-2);
          border-top: 1px solid var(--border);
        }
        .cfo-table-export {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: transparent;
          border: 1px solid var(--border);
          color: var(--text-dim);
          font-size: 11.5px;
          padding: 4px 9px;
          border-radius: 999px;
          cursor: pointer;
          transition: background 0.12s, color 0.12s, border-color 0.12s;
          font-family: var(--font-sans), sans-serif;
        }
        .cfo-table-export:hover {
          background: var(--accent-bg);
          border-color: var(--accent-dim);
          color: var(--accent);
        }
      `}</style>
    </div>
  );
}

// ─── Formatting helpers ──────────────────────────────────────────────────

function alignFor(format?: TableColumn["format"]): "left" | "right" {
  if (!format) return "left";
  return format === "money" || format === "pct" || format === "int"
    ? "right"
    : "left";
}

function formatCell(value: unknown, format?: TableColumn["format"]): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : (value as number);
  switch (format) {
    case "money":
      return Number.isFinite(n)
        ? n.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 2,
            minimumFractionDigits: 2,
          })
        : String(value);
    case "pct":
      return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(value);
    case "int":
      return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value);
    case "date":
      return String(value);
    default:
      return String(value);
  }
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
