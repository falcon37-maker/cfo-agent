// Cohort retention heatmap. Rows = signup cohorts; columns = cycle (M0..Mn).
// Each cell = % of the cohort still billing (Approved) at that cycle, shaded
// green→red by retention. Cells a cohort hasn't reached yet are blank.

import type { CohortRow } from "@/lib/phx-cohort/churn";

function monthLabel(cohort: string): string {
  const [y, m] = cohort.split("-").map(Number);
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${names[m - 1]} ${y}`;
}

/** Green (high retention) → red (low). Returns an rgba background. */
function shade(retention: number): string {
  // retention in [0,1]; 1 → green, 0 → red, blend through amber.
  const r = retention > 0.5 ? Math.round(255 * (1 - retention) * 2) : 255;
  const g = retention > 0.5 ? 200 : Math.round(255 * retention * 2);
  return `rgba(${r}, ${g}, 90, 0.18)`;
}

export function CohortRetentionTable({
  cohorts,
  maxCycle = 6,
}: {
  cohorts: CohortRow[];
  maxCycle?: number;
}) {
  const cycles = Array.from({ length: maxCycle + 1 }, (_, i) => i);

  return (
    <div className="table-wrap" style={{ overflowX: "auto" }}>
      <table className="pnl-table cohort-table">
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num">Size</th>
            {cycles.map((c) => (
              <th key={c} className="num">
                {c === 0 ? "VIP" : `M${c}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((row) => (
            <tr key={row.cohort}>
              <td>{monthLabel(row.cohort)}</td>
              <td className="num muted">{row.size.toLocaleString()}</td>
              {cycles.map((c) => {
                const active = row.active[c] ?? 0;
                // A cycle the cohort hasn't reached shows 0 active for all
                // cycles beyond its last non-zero one → render blank.
                const reached =
                  c === 0 ||
                  row.active.slice(0, c).some((v) => v > 0);
                if (!reached || (c > 0 && active === 0 && row.active[c - 1] === 0)) {
                  return <td key={c} className="num muted">·</td>;
                }
                const retention = row.size > 0 ? active / row.size : 0;
                return (
                  <td
                    key={c}
                    className="num"
                    style={{ background: shade(retention) }}
                    title={`${active} active`}
                  >
                    {(retention * 100).toFixed(0)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
