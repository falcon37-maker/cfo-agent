// What the AI sees about our database. This is the ONLY way the model
// learns about tables — there is no information_schema introspection at
// query time. Anything not listed here doesn't exist as far as the model
// is concerned.
//
// To expose a new table to the agent:
//   1. Add it to ALLOWED_TABLES with the readable column list.
//   2. Mark any columns that should NEVER leave the server in `forbiddenColumns`.
//   3. Document the table's purpose in a one-line description.
//
// To remove access: delete the entry. The query planner's whitelist check
// blocks anything missing from this file.

export type ColumnMeta = {
  name: string;
  type: string; // pg type like "uuid", "numeric", "date", "timestamptz", "text", "bool", "int4", "jsonb"
  description?: string;
};

export type TableMeta = {
  name: string;
  description: string;
  /** Tenant scoping is automatic — listed here only so the model knows
   *  the column exists. It will be filtered server-side regardless. */
  has_tenant_id: boolean;
  /** Columns the model is allowed to SELECT. */
  columns: ColumnMeta[];
  /** Common query patterns — written for the model, not for compile time. */
  usage_notes?: string[];
};

/** Tables the agent is allowed to read FROM. Anything missing here is
 *  invisible + un-queryable. */
export const ALLOWED_TABLES: TableMeta[] = [
  {
    name: "daily_pnl",
    description:
      "Computed per-store-day P&L rollup. The source of truth for Shopify-side revenue, COGS, fees, refunds, ad spend, gross/net profit, margin. One row per (store_id, date).",
    has_tenant_id: true,
    columns: [
      { name: "store_id", type: "text", description: "Store code (NOVA/NURA/KOVA/ELARA/SOLEN/VOLEN/NEEDOH)" },
      { name: "date", type: "date", description: "Calendar day" },
      { name: "revenue", type: "numeric", description: "Shopify 'Net sales' (= gross_sales − refunds). Matches what Shopify Admin → Analytics → Sales Report shows. For PHX stores this also includes subscription enrollment dollars on the Shopify side." },
      { name: "cogs", type: "numeric", description: "Cost of Goods Sold for the day" },
      { name: "ad_spend", type: "numeric", description: "Total ad spend across platforms" },
      { name: "shipping_cost", type: "numeric" },
      { name: "fees", type: "numeric", description: "Payment-processor fees" },
      { name: "gross_profit", type: "numeric", description: "revenue - cogs" },
      { name: "net_profit", type: "numeric", description: "revenue - cogs - fees - ad_spend - shipping_cost. Refunds are NOT subtracted again — they're already removed from revenue (Phase 2: revenue = Shopify Net Sales)." },
      { name: "margin_pct", type: "numeric", description: "net_profit / revenue * 100" },
      { name: "refunds", type: "numeric" },
      { name: "order_count", type: "int4" },
      { name: "computed_at", type: "timestamptz" },
    ],
    usage_notes: [
      "For TOTAL revenue across all stores, do NOT sum revenue directly — for PHX stores (NOVA/NURA/KOVA) the Shopify revenue overlaps with subscription enrollment dollars in phx_summary_snapshots. Use the phx_summary_snapshots.revenue_total for PHX stores and daily_pnl.revenue only for non-PHX stores.",
      "Ad spend is logged manually + synced from platforms; days with $0 ad_spend often mean a logging gap, not actual zero.",
    ],
  },

  {
    name: "daily_orders",
    description:
      "Aggregated Shopify orders per (store, date). Raw order counts, gross sales, discounts, refunds, shipping, tax, net revenue.",
    has_tenant_id: true,
    columns: [
      { name: "store_id", type: "text" },
      { name: "date", type: "date" },
      { name: "order_count", type: "int4" },
      { name: "unit_count", type: "int4" },
      { name: "gross_sales", type: "numeric", description: "Shopify subtotalPriceSet — order subtotal AFTER discounts, BEFORE refunds. Cancelled orders excluded." },
      { name: "discounts", type: "numeric" },
      { name: "refunds", type: "numeric" },
      { name: "shipping", type: "numeric" },
      { name: "tax", type: "numeric" },
      { name: "net_revenue", type: "numeric", description: "gross_sales − refunds. Matches Shopify Sales Report 'Net sales'." },
      { name: "currency", type: "text" },
      { name: "synced_at", type: "timestamptz" },
    ],
  },

  {
    name: "daily_ad_spend",
    description:
      "Per-platform daily ad spend (Meta / Google / etc.). One row per (store, date, platform).",
    has_tenant_id: true,
    columns: [
      { name: "store_id", type: "text" },
      { name: "date", type: "date" },
      { name: "platform", type: "text", description: "e.g. 'meta', 'google'" },
      { name: "spend", type: "numeric" },
      { name: "impressions", type: "int8" },
      { name: "clicks", type: "int8" },
      { name: "currency", type: "text" },
      { name: "synced_at", type: "timestamptz" },
    ],
  },

  {
    name: "ad_spend_entries",
    description:
      "Audit log of manual ad-spend submissions (who logged what, when). For aggregated reads, prefer daily_ad_spend or daily_pnl.ad_spend instead.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "uuid" },
      { name: "store_id", type: "text" },
      { name: "date", type: "date" },
      { name: "amount", type: "numeric" },
      { name: "submitted_by", type: "text" },
      { name: "submitted_at", type: "timestamptz" },
    ],
  },

  {
    name: "cogs_entries",
    description:
      "Audit log of manual COGS submissions. For aggregated reads, prefer daily_pnl.cogs instead.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "uuid" },
      { name: "store_id", type: "text" },
      { name: "date", type: "date" },
      { name: "cogs", type: "numeric" },
      { name: "submitted_by", type: "text" },
      { name: "submitted_at", type: "timestamptz" },
    ],
  },

  {
    name: "manual_revenue_entries",
    description:
      "Free-form revenue logging for non-API sources (coaching, consulting, one-offs). Adds to total revenue but doesn't come from Shopify or Solvpath.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "uuid" },
      { name: "store_id", type: "text", description: "Optional — nullable" },
      { name: "date", type: "date" },
      { name: "revenue_type", type: "text" },
      { name: "description", type: "text" },
      { name: "amount", type: "numeric" },
      { name: "notes", type: "text" },
      { name: "created_at", type: "timestamptz" },
    ],
  },

  {
    name: "stores",
    description:
      "Store registry. Static metadata: id, name, currency, timezone, processing fees, store_type.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "text", description: "Store code (PK)" },
      { name: "name", type: "text" },
      { name: "shop_domain", type: "text" },
      { name: "currency", type: "text" },
      { name: "timezone", type: "text" },
      { name: "is_active", type: "bool" },
      { name: "default_cogs_per_order", type: "numeric" },
      { name: "processing_fee_pct", type: "numeric" },
      { name: "processing_fee_fixed", type: "numeric" },
      { name: "store_type", type: "text", description: "'shopify' or 'manual'" },
      { name: "chargeblast_descriptor", type: "text" },
      { name: "solvpath_store_code", type: "int4" },
      { name: "created_at", type: "timestamptz" },
      // NOTE: encrypted token columns are deliberately NOT exposed.
    ],
    usage_notes: [
      "NOVA, NURA, KOVA are PHX subscription stores. Others (ELARA, SOLEN, VOLEN, NEEDOH) are Shopify-only dropshipping.",
    ],
  },

  {
    name: "phx_summary_snapshots",
    description:
      "Phoenix/Solvpath subscription side. One row per (store_id, range_from=range_to) for daily snapshots, plus PORTFOLIO rollups. Revenue split into direct / initial / recurring / salvage / upsell buckets.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "uuid" },
      { name: "store_id", type: "text", description: "PHX store (NOVA/NURA/KOVA) or 'PORTFOLIO' for the rollup" },
      { name: "range_from", type: "date", description: "Start of period this row represents" },
      { name: "range_to", type: "date", description: "End of period; equal to range_from for daily rows" },
      { name: "scraped_at", type: "timestamptz" },
      { name: "revenue_direct", type: "numeric", description: "One-time non-subscription sales" },
      { name: "revenue_initial", type: "numeric", description: "First VIP subscription charge (20-day post-enrollment)" },
      { name: "revenue_recurring", type: "numeric", description: "Monthly rebills" },
      { name: "revenue_salvage", type: "numeric", description: "Dunning recovery" },
      { name: "revenue_upsell", type: "numeric" },
      { name: "revenue_total", type: "numeric", description: "Sum of the five revenue buckets above" },
      { name: "active_subscribers", type: "int4" },
      { name: "cancelled_subscribers", type: "int4" },
      { name: "subscribers_in_salvage", type: "int4" },
      { name: "new_subscribers", type: "int4" },
      { name: "net_subscribers", type: "int4" },
      { name: "cancelled_subscribers_period", type: "int4" },
      { name: "subscriptions_to_bill", type: "int4" },
      { name: "total_transactions_mtd", type: "int4" },
      { name: "direct_sale_count", type: "int4" },
      { name: "initial_subscription_count", type: "int4" },
      { name: "recurring_subscription_count", type: "int4" },
      { name: "subscription_salvage_count", type: "int4" },
      { name: "upsell_count", type: "int4" },
      { name: "refund_total", type: "numeric" },
      { name: "refund_agent", type: "numeric" },
      { name: "refund_ethoca", type: "numeric" },
      { name: "refund_cdrn", type: "numeric" },
      { name: "refund_rdr_withdrawals", type: "numeric" },
      { name: "refund_chargeback_withdrawals", type: "numeric" },
      { name: "refunds_mtd_count", type: "int4" },
      { name: "refunds_mtd_pct", type: "numeric" },
      { name: "chargebacks_mtd_count", type: "int4" },
      { name: "chargebacks_mtd_pct", type: "numeric" },
      { name: "target_cac", type: "numeric" },
    ],
    usage_notes: [
      "For daily numbers, filter range_from=range_to (single-day rows).",
      "store_id='PORTFOLIO' is the cross-store rollup — use it for total active subscribers, MRR estimate, etc.",
      "For 'subscription revenue' as a concept: revenue_initial + revenue_recurring + revenue_salvage.",
    ],
  },

  {
    name: "chargeblast_alerts",
    description:
      "Chargeback alerts from Chargeblast. One row per alert. Status moves through pending → won/lost/refunded.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "text" },
      { name: "store_id", type: "text", description: "May be null if descriptor not yet mapped" },
      { name: "merchant_descriptor", type: "text" },
      { name: "card_brand", type: "text" },
      { name: "alert_type", type: "text" },
      { name: "amount", type: "numeric" },
      { name: "currency", type: "text" },
      { name: "status", type: "text" },
      { name: "reason", type: "text" },
      { name: "chargeblast_created_at", type: "timestamptz" },
      { name: "chargeblast_updated_at", type: "timestamptz" },
      // NOTE: customer_email + order_id deliberately NOT exposed (PII).
    ],
  },

  {
    name: "paysight_transactions",
    description:
      "Paysight payment processor — one row per individual transaction (checkout charges AND subscription rebills) for Paysight-processed stores. This is the raw transaction ledger, separate from the PHX/Solvpath subscription snapshots in phx_summary_snapshots.",
    has_tenant_id: true,
    columns: [
      { name: "id", type: "bigint" },
      { name: "store_id", type: "text", description: "Store code" },
      { name: "amount", type: "numeric", description: "Transaction amount" },
      { name: "currency", type: "text" },
      { name: "status", type: "text", description: "Transaction status text" },
      { name: "success", type: "boolean", description: "TRUE = the charge succeeded. Always filter success=true for revenue." },
      { name: "refunded", type: "boolean" },
      { name: "charged_back", type: "boolean" },
      { name: "txn_date", type: "date", description: "Calendar day of the transaction (store timezone)" },
      { name: "completed_at", type: "timestamptz" },
      { name: "payment_number", type: "int4", description: "Billing cycle number. 0 = initial checkout order (this is STORE revenue, not subscription revenue). >=1 = a subscription REBILL." },
      { name: "attempt", type: "int4", description: "Retry attempt within a payment_number" },
      { name: "sub_id", type: "bigint", description: "Subscription id this transaction belongs to (null for one-off)" },
      { name: "gateway", type: "text" },
      { name: "mid", type: "text", description: "Merchant account id" },
      { name: "descriptor", type: "text" },
      // NOTE: email / first_name / last_name / last4 / bin deliberately NOT
      // exposed here (PII).
    ],
    usage_notes: [
      "For revenue, ALWAYS filter success=true. Failed/declined attempts have success=false and must be excluded.",
      "SUBSCRIPTION revenue (a.k.a. 'Subs Rev') from Paysight = rebills only: filter payment_number >= 1. Rows with payment_number = 0 are the initial checkout order and count as STORE (Shopify) revenue, NOT subscription revenue.",
      "For 'today's Paysight subscription revenue', filter txn_date = today, success = true, payment_number >= 1, and sum(amount).",
      "For total Paysight processed volume (all charges incl. checkout), filter success = true and sum(amount) with no payment_number filter.",
      "Total platform Subscription Revenue = PHX billed (phx_summary_snapshots: revenue_initial + revenue_recurring + revenue_salvage for NOVA/NURA/KOVA) PLUS Paysight rebills (this table, payment_number >= 1). They are additive across different stores.",
      "To subtract refunds/chargebacks, exclude refunded=true and charged_back=true, or account for them separately.",
    ],
  },

  {
    name: "products",
    description:
      "Per-variant product catalog with COGS. One row per (store_id, shopify_variant_id).",
    has_tenant_id: false, // scoped via stores join — see usage_notes
    columns: [
      { name: "store_id", type: "text" },
      { name: "shopify_variant_id", type: "int8" },
      { name: "shopify_product_id", type: "int8" },
      { name: "sku", type: "text" },
      { name: "title", type: "text" },
      { name: "variant_title", type: "text" },
      { name: "cogs", type: "numeric", description: "Per-unit cost; nullable" },
      { name: "currency", type: "text" },
      { name: "updated_at", type: "timestamptz" },
    ],
    usage_notes: [
      "Tenant-scoped via stores (store_id FK). The server enforces it.",
    ],
  },
];

/** Tables/columns the agent must NEVER see. Listed here so a future
 *  reviewer understands what was intentionally excluded. The whitelist
 *  above is the actual enforcement. */
export const EXPLICITLY_BLOCKED = {
  tables: [
    "tenants",
    "tenant_memberships",
    "pending_invitations",
    "chat_sessions",
    "chat_messages",
    "chat_audit_log",
    "integrations", // contains encrypted credentials
    "zoho_credentials", // OAuth tokens
    "phx_subscribers", // PII (emails)
    "phx_rebills",
    "phx_cohorts",
  ],
  columns_in_allowed_tables: {
    stores: [
      "shopify_token_encrypted",
      "shopify_client_id",
      "shopify_client_secret_encrypted",
      "tenant_id",
    ],
    chargeblast_alerts: ["customer_email", "order_id", "tenant_id"],
  },
};

/** Render the schema as a string the model can read in its system prompt.
 *  Compact enough to fit in cache; detailed enough that the model knows
 *  which columns exist on which tables. */
export function describeSchemaForModel(): string {
  const parts: string[] = [];
  parts.push(
    "# Database schema (what you can query)",
    "",
    "All queries automatically filter by tenant_id — you don't include it in WHERE.",
    "",
  );
  for (const t of ALLOWED_TABLES) {
    parts.push(`## ${t.name}`);
    parts.push(t.description);
    parts.push("");
    parts.push("Columns:");
    for (const c of t.columns) {
      const desc = c.description ? ` — ${c.description}` : "";
      parts.push(`  - ${c.name} (${c.type})${desc}`);
    }
    if (t.usage_notes && t.usage_notes.length > 0) {
      parts.push("");
      parts.push("Notes:");
      for (const note of t.usage_notes) parts.push(`  - ${note}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

/** Quick lookup for the validator. */
export function getTableMeta(name: string): TableMeta | null {
  return ALLOWED_TABLES.find((t) => t.name === name) ?? null;
}
