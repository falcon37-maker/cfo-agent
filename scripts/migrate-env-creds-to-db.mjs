// One-shot migration: scan .env for {CODE}_DOMAIN + {CODE}_TOKEN pairs and
// move them into the stores table (shopify_domain + shopify_token_encrypted),
// encrypted at rest. After this runs, sync code can stop falling back to
// env vars — the database becomes the single source of truth.
//
// Usage:
//   node --env-file=.env scripts/migrate-env-creds-to-db.mjs            # dry-run by default
//   node --env-file=.env scripts/migrate-env-creds-to-db.mjs --apply    # actually write
//
// Idempotent: a store row that already has shopify_token_encrypted set
// is skipped (we don't overwrite a manually-pasted token with an env one).

import { createClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

// Inline-encrypt (mirrors src/lib/crypto.ts).
function loadKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENCRYPTION_KEY not set");
  let key;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) throw new Error(`KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  return key;
}
const KEY = loadKey();
function encrypt(plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

const APPLY = process.argv.includes("--apply");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log(`\n═══ env → DB credential migration ═══`);
console.log(`   Mode: ${APPLY ? "APPLY (writing to DB)" : "DRY-RUN (no DB writes)"}`);
console.log("");

// 1. Find every {CODE}_DOMAIN env var.
const envCodes = new Set();
for (const key of Object.keys(process.env)) {
  const m = key.match(/^([A-Z][A-Z0-9_]*)_DOMAIN$/);
  if (!m) continue;
  const code = m[1];
  if (process.env[`${code}_TOKEN`]) envCodes.add(code);
}
console.log(`Found env creds for: ${Array.from(envCodes).sort().join(", ") || "(none)"}\n`);

// 2. For each, look up the store row, decide what to do.
const plan = [];
for (const code of Array.from(envCodes).sort()) {
  const domain = process.env[`${code}_DOMAIN`];
  const token = process.env[`${code}_TOKEN`];
  const clientId = process.env[`${code}_CLIENT_ID`] || null;

  const { data: row, error } = await sb
    .from("stores")
    .select("id, shopify_domain, shopify_token_encrypted, shopify_client_id, shopify_client_secret_encrypted, tenant_id")
    .eq("id", code)
    .maybeSingle();
  if (error) {
    plan.push({ code, action: "skip", reason: `lookup error: ${error.message}` });
    continue;
  }
  if (!row) {
    plan.push({ code, action: "skip", reason: "no store row exists yet — create via UI first" });
    continue;
  }
  if (row.shopify_token_encrypted) {
    plan.push({ code, action: "skip", reason: "DB already has shopify_token_encrypted (won't overwrite)" });
    continue;
  }
  if (row.shopify_client_secret_encrypted) {
    plan.push({ code, action: "skip", reason: "DB has OAuth secret already" });
    continue;
  }

  // Detect token shape — only shpat_ tokens migrate this way; shpss_ needs
  // a client_id paired with it.
  if (token.startsWith("shpat_")) {
    plan.push({
      code,
      action: "migrate-static",
      domain,
      token,
      tenantId: row.tenant_id,
      reason: `→ shopify_domain = ${domain}, shopify_token_encrypted (encrypted)`,
    });
  } else if (token.startsWith("shpss_") && clientId) {
    plan.push({
      code,
      action: "migrate-oauth",
      domain,
      clientId,
      secret: token,
      tenantId: row.tenant_id,
      reason: `→ shopify_domain, shopify_client_id, shopify_client_secret_encrypted`,
    });
  } else {
    plan.push({ code, action: "skip", reason: `unrecognized token shape (${token.slice(0, 8)}…)` });
  }
}

console.log("Plan:");
for (const p of plan) {
  console.log(`  ${p.code.padEnd(10)} ${p.action.padEnd(18)} ${p.reason}`);
}
console.log("");

if (!APPLY) {
  console.log("Dry-run complete. Re-run with --apply to write to DB.\n");
  process.exit(0);
}

// 3. Apply writes.
let writes = 0, errs = 0;
for (const p of plan) {
  if (p.action === "skip") continue;
  const update = { shopify_domain: p.domain };
  if (p.action === "migrate-static") {
    update.shopify_token_encrypted = encrypt(p.token);
    update.shopify_client_id = null;
    update.shopify_client_secret_encrypted = null;
  } else if (p.action === "migrate-oauth") {
    update.shopify_client_id = p.clientId;
    update.shopify_client_secret_encrypted = encrypt(p.secret);
    update.shopify_token_encrypted = null;
  }
  const { error } = await sb
    .from("stores")
    .update(update)
    .eq("id", p.code)
    .eq("tenant_id", p.tenantId);
  if (error) {
    console.log(`  ✗ ${p.code}: ${error.message}`);
    errs++;
  } else {
    console.log(`  ✓ ${p.code}: migrated`);
    writes++;
  }
}

console.log(`\n${writes} migrated, ${errs} errors.`);
console.log(`\nNext steps:`);
console.log(`  1. Verify in /settings drawer that each store shows "Static token in DB" badge.`);
console.log(`  2. Once confirmed, you can delete ${Array.from(envCodes).map(c => `${c}_DOMAIN/${c}_TOKEN`).join(", ")} from .env.`);
console.log(`  3. Code change: stores.ts already prefers DB over env — no code edit needed unless you want to strip env support entirely.\n`);
