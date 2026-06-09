// Server component banner — shows a small warning strip at the top of the
// shell when there are open data-validation issues for the current tenant.
// Reads data_validation_log directly so no client round-trip is needed.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireTenant } from "@/lib/tenant";
import { AlertTriangle } from "lucide-react";

export async function ValidationBanner() {
  let tenantId: string;
  try {
    const t = await requireTenant();
    tenantId = t.id;
  } catch {
    return null; // not authed — middleware will handle redirect
  }

  const sb = supabaseAdmin();
  const { data } = await sb
    .from("data_validation_log")
    .select("severity, check_name")
    .eq("tenant_id", tenantId)
    .eq("status", "open");
  const rows = data ?? [];
  if (rows.length === 0) return null;

  const errors = rows.filter((r) => r.severity === "error").length;
  const warns = rows.filter((r) => r.severity === "warn").length;
  const tone = errors > 0 ? "error" : "warn";
  const text =
    errors > 0
      ? `${errors} data error${errors === 1 ? "" : "s"}${warns > 0 ? ` + ${warns} warning${warns === 1 ? "" : "s"}` : ""}`
      : `${warns} data warning${warns === 1 ? "" : "s"}`;

  // Most common check names → short user-readable hints.
  const uniqueChecks = Array.from(new Set(rows.map((r) => r.check_name)));
  const hint = uniqueChecks.slice(0, 3).map(humanize).join(" · ");

  return (
    <div className={`validation-banner validation-banner--${tone}`}>
      <AlertTriangle size={14} />
      <span className="vb-text">
        <strong>{text}</strong> {hint ? `— ${hint}` : ""}
      </span>
    </div>
  );
}

function humanize(check: string): string {
  switch (check) {
    case "negative_net_revenue":
      return "negative net revenue";
    case "inactive_store":
      return "store with zero orders";
    case "missing_shopify_credentials":
      return "Shopify credentials missing";
    case "phx_recurring_zero":
      return "missing recurring subs";
    case "missing_daily_orders":
      return "missing daily-orders rows";
    case "missing_phx_snapshot":
      return "missing PHX snapshot day(s)";
    case "suspicious_zero_streak":
      return "store stopped syncing (token may be revoked)";
    default:
      return check.replace(/_/g, " ");
  }
}
