// Presentational table footer bar — matches the screenshot's pagination
// strip: a row count + context label on the left (with an optional
// "Export to CSV" action) and a page indicator on the right. Aggregate
// subscription tables fit on a single page, so the page control is a static
// "1" with disabled arrows — it carries the screenshot's look without adding
// any paging logic.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { ExportCsvButton } from "./ExportCsvButton";

type Props = {
  /** Number of rows rendered in the table above. */
  count: number;
  /** Context shown after the count, e.g. the active range label. */
  label?: string;
  /** When provided, renders an "Export to CSV" button for the visible rows. */
  csv?: {
    headers: string[];
    rows: Array<Array<string | number>>;
    filename: string;
  };
};

export function TableFooter({ count, label, csv }: Props) {
  return (
    <div className="table-foot">
      <div className="table-foot-left">
        <span className="table-foot-info">
          Showing <strong>{count}</strong> of <strong>{count}</strong>{" "}
          {count === 1 ? "row" : "rows"}
          {label ? <span className="table-foot-ctx"> · {label}</span> : null}
        </span>
        {csv ? <ExportCsvButton {...csv} /> : null}
      </div>

      <div className="table-foot-right">
        <span className="table-foot-chip">Page 1 of 1</span>
        <div className="pagination-controls" aria-label="Pagination">
          <button
            type="button"
            className="pg-arrow"
            disabled
            aria-label="Previous page"
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="pg-arrow"
            disabled
            aria-label="Next page"
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
