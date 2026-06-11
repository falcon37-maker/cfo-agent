// Paysight backfill — pulls subscriptions + transactions for the last N days
// into paysight_subscriptions / paysight_transactions. Mirrors
// src/lib/paysight/sync.ts exactly.
//
// Usage:  node --env-file=.env scripts/paysight-backfill.mjs [days]
//   days defaults to 30.

import { createClient } from "@supabase/supabase-js";

const DAYS = Number(process.argv[2]) || 30;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BASE = process.env.PAYSIGHT_BASE_URL;
const API_KEY = process.env.PAYSIGHT_API_KEY;
const CLIENT_ID = process.env.PAYSIGHT_CLIENT_ID;
const EMAIL = process.env.PAYSIGHT_USER_EMAIL;

const { data: tenants } = await sb.from("tenants").select("id").eq("is_active", true).limit(1);
const TENANT = tenants?.[0]?.id;
if (!TENANT) { console.error("no active tenant"); process.exit(1); }

console.log(`\n═══ Paysight backfill: last ${DAYS} days ═══`);
console.log(`   tenant=${TENANT.slice(0,8)} base=${BASE}\n`);

async function post(path, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(BASE.replace(/\/+$/,"") + path, {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization: API_KEY, ClientId: CLIENT_ID, UserEmail: EMAIL, Accept:"application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      await new Promise(f => setTimeout(f, 1000 * Math.pow(2, i)));
      continue;
    }
    throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0,200)}`);
  }
  throw new Error(`${path}: failed after ${retries} retries`);
}

const STORE_BY_DESCRIPTOR = [
  { match: /nuracare/i, store: "NURA" },
  { match: /kovacare/i, store: "KOVA" },
  { match: /novasense|nova[\s.]?usa|ross-usa/i, store: "NOVA" },
];
function storeFromDescriptor(d) {
  if (!d) return null;
  for (const { match, store } of STORE_BY_DESCRIPTOR) if (match.test(d.trim())) return store;
  return null;
}
const r2 = (n) => Math.round(n * 100) / 100;

function subRow(s) {
  return {
    tenant_id: TENANT, paysight_subscription_id: s.id,
    parent_company_id: s.parentCompanyId, company_id: s.companyId,
    customer_id: s.customerId, order_id: s.orderId, sub_plan_id: s.subId,
    store_id: storeFromDescriptor(s.descriptor), mid: s.mid, descriptor: s.descriptor,
    active: s.active, frozen: s.frozen, unsubscribe_order_id: s.unsubscribeOrderId,
    email: s.email, sub_date: s.subDate, unsub_date: s.unsubDate, raw: s,
    synced_at: new Date().toISOString(),
  };
}
function txRow(t) {
  return {
    tenant_id: TENANT, paysight_transaction_id: t.transactionId,
    order_id: t.orderId, customer_id: t.customerId, application_id: t.applicationId,
    store_id: storeFromDescriptor(t.descriptor), mid: t.mid, descriptor: t.descriptor,
    amount: r2(Number(t.amount ?? 0)), currency: t.currency, status: t.status,
    status_id: t.statusId, success: t.success, refunded: t.refunded,
    charged_back: t.chargedBack, has_alert: t.hasAlert, original_transaction_id: t.originalTransactionId,
    email: t.email, first_name: t.firstName, last_name: t.lastName, bin: t.bin, last4: t.last4,
    sent_at: t.sent, completed_at: t.completed, txn_date: (t.completed||t.sent||"").slice(0,10) || null,
    gateway: t.gateway, gateway_transaction_id: t.gatewayTransactionId, sandbox: !!t.sandbox,
    raw: t, synced_at: new Date().toISOString(),
  };
}

async function upsert(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i+500), { onConflict: conflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// Build the list of dates (newest first)
const today = new Date();
const dates = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
  dates.push(d.toISOString().slice(0,10));
}

let totalSubs = 0, totalTx = 0;
for (const date of dates) {
  // Subscriptions: 1-day window
  let subRows = [], page = 1;
  while (true) {
    const resp = await post("/api/mitigation/subscriptions", { pageNumber: page, limit: 1000, dateFrom: date, dateTo: date });
    for (const s of resp.subscriptions ?? []) subRows.push(subRow(s));
    if (!resp.moreResults || !resp.subscriptions?.length) break;
    page++;
  }
  // Transactions: 1-day window (keeps it simple + within rate limits)
  let txRows = [], seen = new Set(); page = 1;
  while (true) {
    const resp = await post("/api/mitigation/transactions", { pageNumber: page, limit: 1000, dateFrom: date, dateTo: date });
    for (const t of resp.transactions ?? []) {
      if (seen.has(t.transactionId)) continue;
      seen.add(t.transactionId); txRows.push(txRow(t));
    }
    if (!resp.moreResults || !resp.transactions?.length) break;
    page++;
  }

  if (subRows.length) await upsert("paysight_subscriptions", subRows, "tenant_id,paysight_subscription_id");
  if (txRows.length) await upsert("paysight_transactions", txRows, "tenant_id,paysight_transaction_id");

  const rev = r2(txRows.filter(t=>t.success).reduce((a,t)=>a+t.amount,0));
  totalSubs += subRows.length; totalTx += txRows.length;
  console.log(`  ${date}:  ${String(subRows.length).padStart(4)} subs · ${String(txRows.length).padStart(4)} tx · $${rev.toFixed(2).padStart(10)} rev`);

  // Gentle pacing to respect 40 req/min on broad transaction search
  await new Promise(f => setTimeout(f, 300));
}

console.log(`\n✓ Backfill done: ${totalSubs} subscriptions, ${totalTx} transactions across ${DAYS} days.\n`);
