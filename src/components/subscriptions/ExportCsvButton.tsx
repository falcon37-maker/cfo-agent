"use client";

// Presentational-only CSV export. Serializes the rows it is HANDED (the ones
// already rendered in the table) into a CSV blob and triggers a download.
// It performs no data fetching and touches no business logic — it just turns
// the visible rows into a downloadable file, matching the screenshot's
// "Export to CSV" footer action.

import { Download } from "lucide-react";

type Props = {
  headers: string[];
  rows: Array<Array<string | number>>;
  filename: string;
};

function escapeCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ExportCsvButton({ headers, rows, filename }: Props) {
  function download() {
    const lines = [
      headers.map(escapeCell).join(","),
      ...rows.map((r) => r.map(escapeCell).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      className="ghost-btn table-foot-export"
      onClick={download}
    >
      <Download size={13} strokeWidth={2} />
      Export to CSV
    </button>
  );
}
